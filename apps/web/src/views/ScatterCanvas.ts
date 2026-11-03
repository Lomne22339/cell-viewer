import { Deck, LinearInterpolator, OrthographicView, type Layer } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { CellStore } from '@core/data/schema';
import {
  applySelectionMask,
  recolorCategorical,
  recolorConstant,
  recolorNumeric,
  type DimOptions
} from '@core/color/recolor';
import { RAMPS } from '@core/color/palette';
import { lodPolicy } from '@core/render/lod';
import { defaultColorField } from '@core/color/defaults';
import { getTheme, type Rgb, type Theme } from '@core/theme/themes';
import type { ScreenRect } from '@core/inset/geometry';

export type ColorKind = 'categorical' | 'numeric';

/** Points drawn at once before level of detail subsamples; 1M pans smoothly on an Apple M4. */
export const DEFAULT_POINT_BUDGET = 1_000_000;

const MAIN_VIEW = 'ortho';
const INSET_VIEW = 'inset';

const OVERLAY_ORDER = ['graph', 'graph-highlight', 'picked', 'selection-preview'];

export interface OrthoViewState {
  target: [number, number, number];
  zoom: number;
  minZoom?: number;
  maxZoom?: number;
  transitionDuration?: number;
  transitionInterpolator?: unknown;
}

export interface InsetSpec {
  rect: ScreenRect;
  target: [number, number];
  zoom: number;
  chunks?: number;
}

interface BinaryAttribute {
  value: Float32Array | Uint8Array;
  size: number;
  normalized?: boolean;
}

export interface ScatterCanvasOptions {
  budget?: number;
  /** Translucent points. Off by default: blending a million points is the costliest setting. */
  blend?: boolean;
  theme?: Theme;
  onViewStateChange?: (vs: OrthoViewState) => void;
  onInsetChange?: () => void;
}

/** Drops `zoomX`/`zoomY`: once scrolled they override `zoom`, so a zoom-only move would not apply. */
function withoutAxisZoom(vs: OrthoViewState): OrthoViewState {
  const { zoomX: _x, zoomY: _y, ...rest } = vs as OrthoViewState & { zoomX?: number; zoomY?: number };
  return rest;
}

/** Point layer; filtered-out cells are culled in the vertex shader (alpha 0 alone still overwrites). */
class CellLayer extends ScatterplotLayer {
  static layerName = 'CellLayer';

  getShaders(): ReturnType<ScatterplotLayer['getShaders']> {
    const shaders = super.getShaders();
    if (this.context.device.type === 'webgpu') return shaders;
    return {
      ...shaders,
      inject: {
        ...(shaders.inject ?? {}),
        'vs:#main-end': 'if (instanceFillColors.a == 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }'
      }
    };
  }
}

/**
 * The shared point-cloud canvas: binary attributes (no per-point accessors), one layer per chunk,
 * not pickable (clicks use the selection worker's grid index), all colors through one `repaint`.
 */
export class ScatterCanvas {
  private deck: Deck<OrthographicView[]>;
  private canvasEl: HTMLCanvasElement;
  private overlays = new Map<string, Layer[]>();
  private colorField: string;
  private colorKind: ColorKind = 'categorical';
  private manualLod: number | null = null;
  private budget: number;
  private ramp = 'viridis';
  private colorVersion = 0;
  private cachedPointLayers: Layer[] = [];
  private chunkAttributes = new Map<number, { start: number; count: number; colorVersion: number; position: BinaryAttribute; color: BinaryAttribute }>();
  private pointLayerKey = '';
  private controllerOn = true;
  private currentMask: Uint8Array | null = null;
  private visible: Uint8Array | null = null;
  private coloredUpTo = 0;
  private blend: boolean;
  private background: Rgb;
  private dimFactor: number;
  private pointDefault: Rgb;
  private inset: InsetSpec | null = null;
  private pendingTransition: { duration: number; interpolator: unknown } | null = null;
  viewState: OrthoViewState;

  constructor(
    private container: HTMLElement,
    private store: CellStore,
    private opts: ScatterCanvasOptions = {}
  ) {
    this.budget = opts.budget ?? DEFAULT_POINT_BUDGET;
    this.blend = opts.blend ?? false;
    const theme = opts.theme ?? getTheme(null);
    this.background = theme.background;
    this.dimFactor = theme.dimFactor;
    this.pointDefault = theme.pointDefault;
    const initial = defaultColorField(store);
    this.colorField = initial?.field ?? '';
    this.colorKind = initial?.kind ?? 'categorical';
    this.viewState = this.initialViewState();
    this.repaintColors(0);

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.appendChild(canvas);
    this.canvasEl = canvas;

    // Controlled, not `initialViewState`: re-applying that resets the view manager on every pan.
    this.deck = new Deck({
      canvas,
      views: this.views(),
      viewState: this.viewStates() as never,
      // No Deck-level `controller`: deck.gl writes it into the caller's `views` array, where it sticks.
      // The main view carries its own controller.
      parameters: { depthCompare: 'always' },
      layerFilter: ({ layer, viewport }) => this.layerInView(layer.id, viewport.id),
      onViewStateChange: ({ viewState, viewId }: { viewState: unknown; viewId: string }) => {
        if (viewId !== MAIN_VIEW) return this.viewStates()[viewId] as never;
        this.viewState = viewState as OrthoViewState;
        // Render first: setProps rebuilds deck.gl's viewports, which the listener projects through.
        this.render();
        this.opts.onViewStateChange?.(this.viewState);
        return viewState as never;
      },
      // deck.gl rewrites the canvas cursor every frame, so the crosshair must be set here.
      getCursor: ({ isDragging }: { isDragging: boolean }) =>
        !this.controllerOn ? 'crosshair' : isDragging ? 'grabbing' : 'grab',
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

  private views(): OrthographicView[] {
    const main = new OrthographicView({ id: MAIN_VIEW, controller: this.controllerOn });
    if (!this.inset) return [main];
    const { x, y, w, h } = this.inset.rect;
    return [
      main,
      new OrthographicView({
        id: INSET_VIEW,
        x,
        y,
        width: w,
        height: h,
        clear: true,
        clearColor: [...this.background, 255],
        controller: false
      })
    ];
  }

  private viewStates(): Record<string, unknown> {
    const main = this.pendingTransition
      ? {
          ...this.viewState,
          transitionDuration: this.pendingTransition.duration,
          transitionInterpolator: this.pendingTransition.interpolator
        }
      : this.viewState;
    if (!this.inset) return { [MAIN_VIEW]: main };
    return {
      [MAIN_VIEW]: main,
      [INSET_VIEW]: { target: [...this.inset.target, 0], zoom: this.inset.zoom, minZoom: -20, maxZoom: 30 }
    };
  }

  private layerInView(id: string, viewId: string): boolean {
    if (viewId === INSET_VIEW) {
      if (id.startsWith('cells-')) return Number(id.slice(6)) < (this.inset?.chunks ?? 1);
      return id.startsWith('graph-') || id.startsWith('inset:');
    }
    return !id.startsWith('inset:');
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

  drawnCount(): number {
    const f = this.lod().renderFraction;
    return Math.min(this.store.loadedCount, Math.ceil(f * this.store.loadedCount));
  }

  pointRadius(): number {
    return this.lod().radius;
  }

  /** Point layers, rebuilt only when their inputs change (a lasso drag re-renders per pointermove). */
  private buildPointLayers(): Layer[] {
    const radius = this.pointRadius();
    const drawn = this.drawnCount();
    const key = `${drawn}|${radius}|${this.colorVersion}|${this.blend ? 1 : 0}`;
    if (key === this.pointLayerKey) return this.cachedPointLayers;

    const layers: Layer[] = [];
    for (let c = 0; c * this.store.chunkSize < drawn; c++) {
      const start = c * this.store.chunkSize;
      const count = Math.min(this.store.chunkSize, drawn - start);
      if (count <= 0) break;
      const attrs = this.attributesFor(c, start, count);
      layers.push(
        new CellLayer({
          id: `cells-${c}`,
          data: {
            length: count,
            attributes: { getPosition: attrs.position, getFillColor: attrs.color }
            // deck.gl's binary-attribute typing omits `normalized`, which the unorm8 colors need.
          } as never,
          radiusUnits: 'pixels',
          getRadius: radius,
          radiusMinPixels: 0.4,
          radiusMaxPixels: 8,
          stroked: false,
          antialiasing: this.blend,
          parameters: this.blend ? {} : { blend: false },
          pickable: false,
          updateTriggers: { getFillColor: this.colorVersion, getRadius: radius }
        }) as unknown as Layer
      );
    }
    this.pointLayerKey = key;
    this.cachedPointLayers = layers;
    return layers;
  }

  private attributesFor(c: number, start: number, count: number): { position: BinaryAttribute; color: BinaryAttribute } {
    let entry = this.chunkAttributes.get(c);
    if (!entry || entry.start !== start || entry.count !== count) {
      entry = {
        start,
        count,
        colorVersion: -1,
        position: { value: this.store.xy.subarray(start * 2, (start + count) * 2), size: 2 },
        color: { value: this.store.color, size: 4 }
      };
      this.chunkAttributes.set(c, entry);
    }
    if (entry.colorVersion !== this.colorVersion) {
      entry.color = { value: this.store.color.subarray(start * 4, (start + count) * 4), size: 4, normalized: true };
      entry.colorVersion = this.colorVersion;
    }
    return entry;
  }

  private overlayLayers(): Layer[] {
    const ordered = [
      ...OVERLAY_ORDER.filter(s => this.overlays.has(s)),
      ...[...this.overlays.keys()].filter(s => !OVERLAY_ORDER.includes(s))
    ];
    return ordered.flatMap(s => this.overlays.get(s) ?? []);
  }

  render(): void {
    // A transition is one-shot; left on `viewState` it would restart on every later render.
    const viewState = this.viewStates();
    this.pendingTransition = null;
    this.deck.setProps({
      viewState: viewState as never,
      layers: [...this.buildPointLayers(), ...this.overlayLayers()]
    });
  }

  element(): HTMLCanvasElement {
    return this.canvasEl;
  }

  storeBounds(): [number, number, number, number] {
    return this.store.bounds;
  }

  size(): { width: number; height: number } {
    return {
      width: this.container.clientWidth || this.canvasEl.clientWidth || 800,
      height: this.container.clientHeight || this.canvasEl.clientHeight || 600
    };
  }

  private dimOptions(): DimOptions {
    return {
      mask: this.blend ? null : this.currentMask,
      factor: this.blend ? 1 : this.dimFactor,
      background: this.background,
      visible: this.visible
    };
  }

  private repaintColors(from: number): void {
    const dim = this.dimOptions();
    if (!this.colorField) {
      recolorConstant(this.store, this.pointDefault, 255, from, dim);
    } else if (this.colorKind === 'categorical') {
      recolorCategorical(this.store, this.colorField, 255, from, dim);
    } else {
      recolorNumeric(this.store, this.colorField, RAMPS[this.ramp] ?? RAMPS.viridis, 255, from, dim);
    }
    if (this.blend && this.currentMask) {
      applySelectionMask(this.store.color, this.currentMask, 28, 255, this.store.loadedCount, this.visible);
    }
    this.coloredUpTo = this.store.loadedCount;
    this.colorVersion++;
  }

  setColorBy(field: string, kind: ColorKind, ramp = this.ramp, from = 0): void {
    this.colorField = field;
    this.colorKind = kind;
    this.ramp = ramp;
    this.repaintColors(from);
    this.render();
  }

  colorBy(): { field: string; kind: ColorKind } {
    return { field: this.colorField, kind: this.colorKind };
  }

  blending(): boolean {
    return this.blend;
  }

  setBlending(on: boolean): void {
    if (this.blend === on) return;
    this.blend = on;
    this.pointLayerKey = '';
    this.setColorBy(this.colorField, this.colorKind, this.ramp, 0);
  }

  refreshColors(): void {
    if (this.store.loadedCount <= this.coloredUpTo) return;
    this.repaintColors(this.coloredUpTo);
    this.render();
  }

  applyMask(mask: Uint8Array | null): void {
    this.currentMask = mask;
    if (this.blend) {
      applySelectionMask(this.store.color, mask, 28, 255, this.store.loadedCount, this.visible);
      this.colorVersion++;
      this.render();
      return;
    }
    this.setColorBy(this.colorField, this.colorKind, this.ramp, 0);
  }

  setVisibility(visible: Uint8Array | null, repaint = true): void {
    this.visible = visible;
    if (repaint) this.setColorBy(this.colorField, this.colorKind, this.ramp, 0);
  }

  setTheme(theme: Theme): void {
    this.background = theme.background;
    this.dimFactor = theme.dimFactor;
    this.pointDefault = theme.pointDefault;
    if (this.inset) this.deck.setProps({ views: this.views() });
    this.setColorBy(this.colorField, this.colorKind, this.ramp, 0);
  }

  setLod(fraction: number | null): void {
    this.manualLod = fraction;
    this.render();
  }

  setOverlay(slot: string, layers: Layer[]): void {
    if (layers.length === 0) this.overlays.delete(slot);
    else this.overlays.set(slot, layers);
    this.render();
  }

  setOverlayLayers(layers: Layer[]): void {
    this.setOverlay('graph', layers);
  }

  setSelectionOverlay(layers: Layer[]): void {
    this.setOverlay('selection-preview', layers);
  }

  setInset(spec: InsetSpec | null): void {
    this.inset = spec;
    this.deck.setProps({ views: this.views() });
    this.render();
    this.opts.onInsetChange?.();
  }

  insetZoom(): number | null {
    return this.inset ? this.inset.zoom : null;
  }

  setInteractive(on: boolean): void {
    if (this.controllerOn === on) return;
    this.controllerOn = on;
    this.deck.setProps({ views: this.views() });
  }

  fitBounds(bbox: [number, number, number, number], transitionMs = 600): void {
    const [x0, y0, x1, y1] = bbox;
    const pad = 1.25;
    const { width: w, height: h } = this.size();
    const zoom = Math.log2(
      Math.min(w / Math.max((x1 - x0) * pad, 1e-6), h / Math.max((y1 - y0) * pad, 1e-6))
    );
    this.viewState = {
      ...withoutAxisZoom(this.viewState),
      target: [(x0 + x1) / 2, (y0 + y1) / 2, 0],
      zoom: Math.min(Number.isFinite(zoom) ? zoom : 0, 20)
    };
    this.pendingTransition = {
      duration: transitionMs,
      interpolator: new LinearInterpolator(['target', 'zoom'])
    };
    this.render();
    this.opts.onViewStateChange?.(this.viewState);
  }

  panTo(target: [number, number], ms: number): void {
    this.viewState = { ...withoutAxisZoom(this.viewState), target: [target[0], target[1], 0] };
    this.pendingTransition = ms > 0 ? { duration: ms, interpolator: new LinearInterpolator(['target']) } : null;
    this.render();
    this.opts.onViewStateChange?.(this.viewState);
  }

  private viewport(id = MAIN_VIEW): { project: (p: number[]) => number[]; unproject: (p: number[]) => number[] } | undefined {
    // deck.gl asserts if asked for viewports before its device initializes (an early click can).
    try {
      return this.deck.getViewports().find(v => v.id === id) as never;
    } catch {
      return undefined;
    }
  }

  screenToWorld(px: number, py: number): [number, number] {
    const vp = this.viewport();
    // NaN, not the origin: callers must not act on a point that does not exist yet.
    if (!vp) return [NaN, NaN];
    const [x, y] = vp.unproject([px, py]);
    return [x, y];
  }

  worldToScreen(x: number, y: number): [number, number] {
    const vp = this.viewport();
    if (!vp) return [NaN, NaN];
    const [px, py] = vp.project([x, y]);
    return [px, py];
  }

  insetWorldToScreen(x: number, y: number): [number, number] | null {
    const vp = this.viewport(INSET_VIEW);
    if (!vp || !this.inset) return null;
    const [px, py] = vp.project([x, y]);
    return [px, py];
  }

  insetScreenToWorld(px: number, py: number): [number, number] | null {
    const vp = this.viewport(INSET_VIEW);
    if (!vp || !this.inset) return null;
    const [x, y] = vp.unproject([px, py]);
    return [x, y];
  }

  /** A lost WebGL context blanks the canvas; our typed arrays rebuild every buffer, so re-render. */
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
