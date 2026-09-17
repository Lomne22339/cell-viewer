import { Deck, LinearInterpolator, OrthographicView, type Layer } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { CellStore } from '@core/data/schema';
import {
  applySelectionMask,
  recolorCategorical,
  recolorNumeric,
  type DimOptions
} from '@core/color/recolor';
import { RAMPS } from '@core/color/palette';
import { lodPolicy } from '@core/render/lod';
import { defaultColorField } from '@core/color/defaults';

export type ColorKind = 'categorical' | 'numeric';

/**
 * Points drawn at once before level of detail starts subsampling.
 *
 * Measured, not guessed. On an Apple M4 through ANGLE/Metal, with blending off,
 * the sweep in docs/benchmarks/2026-09-07-capacity.md records 60 fps at 500k,
 * a steady 30 fps at 1M and 18 fps at 2M. One million is the largest round
 * number that still pans smoothly, and it is what lets a published-scale UMAP
 * be shown whole. A weaker GPU should lower it; the detail slider is the
 * manual override either way.
 */
export const DEFAULT_POINT_BUDGET = 1_000_000;

export interface OrthoViewState {
  target: [number, number, number];
  zoom: number;
  minZoom?: number;
  maxZoom?: number;
  transitionDuration?: number;
  transitionInterpolator?: unknown;
}

export interface ScatterCanvasOptions {
  /** Target points on screen before subsampling kicks in. */
  budget?: number;
  /**
   * Draw points translucently. Off by default: alpha blending a million
   * overlapping points costs roughly four times the frame rate on a
   * tile-based GPU, and the selection highlight does not need it.
   */
  blend?: boolean;
  onViewStateChange?: (vs: OrthoViewState) => void;
  onHover?: (index: number | null, x: number, y: number) => void;
  /** Fires after each frame deck.gl actually draws. Used by the benchmark. */
  onAfterRender?: () => void;
}

/**
 * The shared point-cloud canvas. Both the embedding view and the trajectory
 * view are this class plus their own overlay layers.
 *
 * Two decisions carry the performance here:
 *
 *  1. Layers are fed binary attributes, not a `data` array. deck.gl then
 *     uploads the typed arrays straight to the GPU and never calls an
 *     accessor per point.
 *  2. There is one layer per loaded chunk. A chunk uploads once, when it
 *     arrives; later chunks do not disturb it. Twenty layers of 250k points
 *     is materially cheaper than one layer re-uploaded twenty times.
 */
export class ScatterCanvas {
  private deck: Deck<OrthographicView>;
  private canvasEl: HTMLCanvasElement;
  private overlay: Layer[] = [];
  private selectionOverlay: Layer[] = [];
  private colorField: string;
  private colorKind: ColorKind = 'categorical';
  private manualLod: number | null = null;
  private budget: number;
  private ramp = 'viridis';
  private radiusOverride: number | null = null;
  private colorVersion = 0;
  private cachedPointLayers: Layer[] = [];
  private pointLayerKey = '';
  private rebuildCount = 0;
  private controllerOn = true;
  private currentMask: Uint8Array | null = null;
  private coloredUpTo = 0;
  private blend: boolean;
  private pendingTransition: { duration: number; interpolator: unknown } | null = null;
  private static readonly DIM_FACTOR = 0.22;
  viewState: OrthoViewState;

  constructor(
    private container: HTMLElement,
    private store: CellStore,
    private opts: ScatterCanvasOptions = {}
  ) {
    this.budget = opts.budget ?? DEFAULT_POINT_BUDGET;
    this.blend = opts.blend ?? false;
    const initial = defaultColorField(store);
    this.colorField = initial?.field ?? '';
    this.colorKind = initial?.kind ?? 'categorical';
    this.viewState = this.initialViewState();
    if (initial) {
      if (initial.kind === 'categorical') {
        recolorCategorical(store, initial.field, 255, 0, this.dimOptions());
      } else {
        recolorNumeric(store, initial.field, RAMPS[this.ramp], 255, 0, this.dimOptions());
      }
    }

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.appendChild(canvas);
    this.canvasEl = canvas;

    // Controlled view state, not `initialViewState`.
    //
    // `initialViewState` is read once and re-applying it resets deck.gl's view
    // manager, so driving a pan through it costs a full reset per frame. In
    // controlled mode the view state is just another prop and a pan is a
    // uniform update.
    this.deck = new Deck({
      canvas,
      views: new OrthographicView({ id: 'ortho' }),
      viewState: this.viewState as never,
      controller: true,
      // Points are flat and unordered; depth testing costs fill rate and
      // buys nothing here.
      parameters: { depthCompare: 'always' },
      onViewStateChange: ({ viewState }: { viewState: unknown }) => {
        this.viewState = viewState as OrthoViewState;
        this.opts.onViewStateChange?.(this.viewState);
        this.render();
        return viewState as never;
      },
      onAfterRender: () => this.opts.onAfterRender?.(),
      layers: []
    });
    this.render();
    this.installContextLossRecovery(canvas);
  }

  private initialViewState(): OrthoViewState {
    const [x0, y0, x1, y1] = this.store.bounds;
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    const zoom = Math.log2(
      Math.min(w / Math.max(x1 - x0, 1e-6), h / Math.max(y1 - y0, 1e-6))
    );
    return {
      target: [(x0 + x1) / 2, (y0 + y1) / 2, 0],
      zoom: Number.isFinite(zoom) ? zoom : 0,
      minZoom: -10,
      maxZoom: 20
    };
  }

  private lod(): { renderFraction: number; radius: number } {
    return lodPolicy({
      n: this.store.loadedCount,
      zoom: typeof this.viewState.zoom === 'number' ? this.viewState.zoom : 0,
      bounds: this.store.bounds,
      budget: this.budget,
      manual: this.manualLod
    });
  }

  /** Number of points currently being drawn — reported in the UI and bench. */
  drawnCount(): number {
    const f = this.lod().renderFraction;
    return Math.min(this.store.loadedCount, Math.ceil(f * this.store.loadedCount));
  }

  /**
   * Pins point radius, so the benchmark can hold point count fixed and vary
   * only overdraw. That is what separates a fill-rate limit from a vertex
   * throughput limit.
   */
  setPointRadiusOverride(radius: number | null): void {
    this.radiusOverride = radius;
    this.render();
  }

  /**
   * Point layers, rebuilt only when something that affects them changes.
   *
   * Dragging a lasso fires a pointermove per event, and each one re-renders
   * the deck. Without this cache every one of those moves reconstructed
   * every chunk layer — four layer objects at one million cells, forty at
   * ten million — which is enough to wedge the main thread mid-drag. The
   * key covers everything the layers depend on; deck.gl treats an unchanged
   * layer instance as a no-op.
   */
  private buildPointLayers(): Layer[] {
    const radius = this.radiusOverride ?? this.lod().radius;
    const drawn = this.drawnCount();
    const key = `${drawn}|${radius}|${this.colorVersion}|${this.blend ? 1 : 0}`;
    if (key === this.pointLayerKey) return this.cachedPointLayers;

    const layers: Layer[] = [];
    for (let c = 0; c * this.store.chunkSize < drawn; c++) {
      const start = c * this.store.chunkSize;
      const count = Math.min(this.store.chunkSize, drawn - start);
      if (count <= 0) break;
      layers.push(
        new ScatterplotLayer({
          id: `cells-${c}`,
          data: {
            length: count,
            attributes: {
              getPosition: {
                value: this.store.xy.subarray(start * 2, (start + count) * 2),
                size: 2
              },
              getFillColor: {
                value: this.store.color.subarray(start * 4, (start + count) * 4),
                size: 4,
                normalized: true
              }
            }
          },
          radiusUnits: 'pixels',
          getRadius: radius,
          radiusMinPixels: 0.4,
          radiusMaxPixels: 8,
          stroked: false,
          antialiasing: this.blend,
          parameters: this.blend ? {} : { blend: false },
          pickable: true,
          updateTriggers: { getFillColor: this.colorVersion, getRadius: radius },
          onHover: (info: { index: number; x: number; y: number }) =>
            this.opts.onHover?.(info.index >= 0 ? start + info.index : null, info.x, info.y)
        })
      );
    }
    this.pointLayerKey = key;
    this.rebuildCount++;
    this.cachedPointLayers = layers;
    return layers;
  }

  render(): void {
    // A transition is a one-shot instruction, not part of the view state. If it
    // stayed on `viewState` then every later render — a selection repaint, a
    // detail-slider move — would re-issue it and restart the animation.
    const viewState = this.pendingTransition
      ? {
          ...this.viewState,
          transitionDuration: this.pendingTransition.duration,
          transitionInterpolator: this.pendingTransition.interpolator
        }
      : this.viewState;
    this.pendingTransition = null;
    this.deck.setProps({
      viewState: viewState as never,
      layers: [...this.buildPointLayers(), ...this.overlay, ...this.selectionOverlay]
    });
  }

  /** The DOM element pointer events are bound to. */
  element(): HTMLCanvasElement {
    return this.canvasEl;
  }

  storeBounds(): [number, number, number, number] {
    return this.store.bounds;
  }

  /** deck.gl's own frame breakdown, for diagnosing where time actually goes. */
  metrics(): Record<string, number> {
    return { ...((this.deck as unknown as { metrics: Record<string, number> }).metrics ?? {}) };
  }

  /** How many times the chunk layers have actually been reconstructed. */
  layerRebuilds(): number {
    return this.rebuildCount;
  }

  /** Selection highlight, expressed the way the current blend mode needs. */
  private dimOptions(): DimOptions {
    // In translucent mode the highlight is applied afterwards via alpha, so the
    // colour pass leaves the hue alone.
    return this.blend
      ? { mask: null, factor: 1 }
      : { mask: this.currentMask, factor: ScatterCanvas.DIM_FACTOR };
  }

  setColorBy(field: string, kind: ColorKind, ramp = this.ramp, from = 0): void {
    this.colorField = field;
    this.colorKind = kind;
    this.ramp = ramp;
    if (!field) {
      // A dataset can carry coordinates and nothing else. There is no colour to
      // compute, but the points still have to be drawn.
      this.render();
      return;
    }
    const dim = this.dimOptions();
    if (kind === 'categorical') recolorCategorical(this.store, field, 255, from, dim);
    else recolorNumeric(this.store, field, RAMPS[ramp] ?? RAMPS.viridis, 255, from, dim);
    this.coloredUpTo = this.store.loadedCount;
    if (this.blend && this.currentMask) {
      applySelectionMask(this.store.color, this.currentMask, 28, 255, this.store.loadedCount);
    }
    this.colorVersion++;
    this.render();
  }

  blending(): boolean {
    return this.blend;
  }

  /**
   * Turns translucent rendering on or off.
   *
   * Translucency shows density in crowded regions but costs about four times
   * the frame rate at a million points, so it is worth having and worth
   * leaving off by default.
   */
  setBlending(on: boolean): void {
    if (this.blend === on) return;
    this.blend = on;
    this.pointLayerKey = '';
    this.setColorBy(this.colorField, this.colorKind, this.ramp, 0);
  }

  /**
   * Colours cells that arrived since the last pass.
   *
   * Called once per chunk, so it must touch only the new tail; recolouring
   * everything loaded so far on every chunk is quadratic in the chunk count.
   */
  refreshColors(): void {
    if (!this.colorField) return;
    if (this.store.loadedCount <= this.coloredUpTo) return;
    this.setColorBy(this.colorField, this.colorKind, this.ramp, this.coloredUpTo);
  }

  /**
   * Repaints the highlight for a new selection.
   *
   * In opaque mode this re-derives every colour from the source column so the
   * dimming never compounds; in translucent mode it only rewrites alpha.
   */
  applyMask(mask: Uint8Array | null): void {
    this.currentMask = mask;
    if (this.blend) {
      applySelectionMask(this.store.color, mask, 28, 255, this.store.loadedCount);
      this.colorVersion++;
      this.render();
      return;
    }
    this.setColorBy(this.colorField, this.colorKind, this.ramp, 0);
  }

  setLod(fraction: number | null): void {
    this.manualLod = fraction;
    this.render();
  }

  setOverlayLayers(layers: Layer[]): void {
    this.overlay = layers;
    this.render();
  }

  setSelectionOverlay(layers: Layer[]): void {
    this.selectionOverlay = layers;
    this.render();
  }

  /** Disables deck.gl's pan/zoom controller while a lasso is being drawn. */
  setInteractive(on: boolean): void {
    if (this.controllerOn === on) return;
    this.controllerOn = on;
    this.deck.setProps({ controller: on });
  }

  fitBounds(bbox: [number, number, number, number], transitionMs = 600): void {
    const [x0, y0, x1, y1] = bbox;
    const pad = 1.25;
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    const zoom = Math.log2(
      Math.min(w / Math.max((x1 - x0) * pad, 1e-6), h / Math.max((y1 - y0) * pad, 1e-6))
    );
    this.viewState = {
      ...this.viewState,
      target: [(x0 + x1) / 2, (y0 + y1) / 2, 0],
      zoom: Math.min(Number.isFinite(zoom) ? zoom : 0, 20)
    };
    this.pendingTransition = {
      duration: transitionMs,
      interpolator: new LinearInterpolator(['target', 'zoom'])
    };
    this.render();
  }

  /**
   * Animates the view to a target over `ms`, letting deck.gl drive the frames.
   *
   * The benchmark uses this rather than moving the camera itself each tick, so
   * the frame rate it records is the renderer's, not the caller's.
   */
  panTo(target: [number, number], ms: number): void {
    this.viewState = { ...this.viewState, target: [target[0], target[1], 0] };
    this.pendingTransition = { duration: ms, interpolator: new LinearInterpolator(['target']) };
    this.render();
  }

  /** Pixel coordinates to world coordinates, for lasso capture. */
  screenToWorld(px: number, py: number): [number, number] {
    const vp = this.deck.getViewports()[0];
    if (!vp) return [0, 0];
    const [x, y] = vp.unproject([px, py]);
    return [x, y];
  }

  /**
   * A lost WebGL context blanks the canvas. Every buffer can be rebuilt from
   * the typed arrays we still hold, so the recovery is simply to re-render
   * rather than to reload the dataset.
   */
  private installContextLossRecovery(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('webglcontextlost', ev => {
      ev.preventDefault();
      console.warn('WebGL context lost; will restore from the CPU-side arrays');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.colorVersion++;
      this.render();
    });
  }

  destroy(): void {
    this.deck.finalize();
    this.canvasEl.remove();
  }
}
