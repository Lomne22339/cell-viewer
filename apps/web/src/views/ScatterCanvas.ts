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

const MAIN_VIEW = 'ortho';
const INSET_VIEW = 'inset';

/** Overlay slots, bottom to top. Anything not listed draws above these. */
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
  /** Where the inset sits, in canvas CSS pixels. */
  rect: ScreenRect;
  target: [number, number];
  zoom: number;
  /**
   * How many of the drawn chunks the inset also draws. An overview needs only
   * the first (pre-shuffled, so an unbiased sample); a magnified region needs
   * the same density as the main view or it looks sparser than what it zooms
   * into. Defaults to 1.
   */
  chunks?: number;
}

interface BinaryAttribute {
  value: Float32Array | Uint8Array;
  size: number;
  normalized?: boolean;
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
  /** Background, dimming and default point colour. Defaults to the black theme. */
  theme?: Theme;
  onViewStateChange?: (vs: OrthoViewState) => void;
  /** Fires when the inset view opens, closes, moves or changes zoom. */
  onInsetChange?: () => void;
  /** Fires after each frame deck.gl actually draws. Used by the benchmark. */
  onAfterRender?: () => void;
}

/**
 * A view state with deck.gl's per-axis zoom removed.
 *
 * Once the user has scrolled, deck.gl 9's orthographic view state carries
 * `zoomX`/`zoomY` alongside `zoom`, and the per-axis values win. A camera move
 * that only sets `zoom` — reset view, zoom to selection — would then pan but
 * silently keep the old magnification. Dropping them lets deck.gl derive both
 * from `zoom` again.
 */
function withoutAxisZoom(vs: OrthoViewState): OrthoViewState {
  const { zoomX: _x, zoomY: _y, ...rest } = vs as OrthoViewState & { zoomX?: number; zoomY?: number };
  return rest;
}

/**
 * The point layer, with filtered-out cells culled in the vertex shader.
 *
 * A legend filter hides a cell by giving it alpha 0. With blending off, an
 * alpha-0 fragment would still overwrite whatever is behind it, so the vertex
 * stage moves such a point outside the clip volume instead: it produces no
 * fragments at all, costs nothing to rasterise, and needs no second buffer.
 */
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
 * The shared point-cloud canvas. Both the embedding view and the trajectory
 * view are this class plus their own overlay layers.
 *
 * Decisions that carry the performance here:
 *
 *  1. Layers are fed binary attributes, not a `data` array. deck.gl then
 *     uploads the typed arrays straight to the GPU and never calls an
 *     accessor per point.
 *  2. There is one layer per loaded chunk. A chunk uploads once, when it
 *     arrives; later chunks do not disturb it.
 *  3. Point layers are not pickable. A hover picking pass costs a full extra
 *     render of every point under the cursor's neighbourhood on every pointer
 *     move, and per-cell hover was exactly what the client asked to remove.
 *     Clicks are answered by the selection worker's grid index instead.
 *  4. Every colour decision — colour-by, selection dimming, legend filter,
 *     theme background — goes through one `repaint`, so `store.color` has a
 *     single writer.
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
  private radiusOverride: number | null = null;
  private colorVersion = 0;
  private cachedPointLayers: Layer[] = [];
  /**
   * Binary attribute objects per chunk, reused across layer rebuilds. deck.gl
   * skips a GPU upload when it is handed the identical attribute object, so a
   * zoom (which changes the radius and rebuilds the layers) re-uploads nothing,
   * and a colour change re-uploads colours but never positions.
   */
  private chunkAttributes = new Map<number, { start: number; count: number; colorVersion: number; position: BinaryAttribute; color: BinaryAttribute }>();
  private pointLayerKey = '';
  private rebuildCount = 0;
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

    // Controlled view state, not `initialViewState`.
    //
    // `initialViewState` is read once and re-applying it resets deck.gl's view
    // manager, so driving a pan through it costs a full reset per frame. In
    // controlled mode the view state is just another prop and a pan is a
    // uniform update.
    // deck.gl's callbacks reach this object through `live`, not through `this`:
    // the graphics library keeps its canvas, animation loop and props after
    // `finalize`, so anything they capture stays alive. `destroy` empties
    // `live`, and then all they hold is this small box.
    const live = this.live;
    this.deck = new Deck({
      canvas,
      views: this.views(),
      viewState: this.viewStates() as never,
      // No Deck-level `controller`: deck.gl applies it by writing a clone into
      // index 0 of the caller's `views` array, which then sticks — so turning
      // it off for a lasso drag would silently leave panning on. The main
      // view carries its own controller instead (see `views()`).
      // Points are flat and unordered; depth testing costs fill rate and
      // buys nothing here.
      parameters: { depthCompare: 'always' },
      layerFilter: ({ layer, viewport }) => live.self?.layerInView(layer.id, viewport.id) ?? false,
      onViewStateChange: ({ viewState, viewId }: { viewState: unknown; viewId: string }) => {
        const self = live.self;
        if (!self) return viewState as never;
        if (viewId !== MAIN_VIEW) return self.viewStates()[viewId] as never;
        self.viewState = viewState as OrthoViewState;
        // Render first: deck.gl rebuilds its viewports in setProps, and the
        // listener projects DOM anchors (cards, the inset marker) through them.
        self.render();
        self.opts.onViewStateChange?.(self.viewState);
        return viewState as never;
      },
      onAfterRender: () => live.self?.opts.onAfterRender?.(),
      // deck.gl rewrites the canvas cursor every frame, so the box and lasso
      // crosshair has to come from here, not from the element's style.
      getCursor: ({ isDragging }: { isDragging: boolean }) =>
        live.self && !live.self.controllerOn ? 'crosshair' : isDragging ? 'grabbing' : 'grab',
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

  /**
   * The inset draws only the first chunk — because points are stored
   * pre-shuffled that is an unbiased sample — plus the trajectory backbone and
   * its own `inset:` layers. It reuses the main view's GPU buffers; it is a
   * second viewport, not a second context.
   */
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

  /** Number of points currently being drawn — reported in the UI and bench. */
  drawnCount(): number {
    const f = this.lod().renderFraction;
    return Math.min(this.store.loadedCount, Math.ceil(f * this.store.loadedCount));
  }

  /** On-screen point radius in CSS pixels. */
  pointRadius(): number {
    return this.radiusOverride ?? this.lod().radius;
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
            // deck.gl's binary-attribute typing omits `normalized`, which the
            // runtime honours and the unorm8 colour buffer relies on.
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
    this.rebuildCount++;
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
      // A fresh object over the same memory: deck.gl sees a new value and
      // re-uploads the colours, and only the colours.
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
    // A transition is a one-shot instruction, not part of the view state. If it
    // stayed on `viewState` then every later render — a selection repaint, a
    // detail-slider move — would re-issue it and restart the animation.
    const viewState = this.viewStates();
    this.pendingTransition = null;
    this.deck.setProps({
      viewState: viewState as never,
      layers: [...this.buildPointLayers(), ...this.overlayLayers()]
    });
  }

  /** The DOM element pointer events are bound to. */
  element(): HTMLCanvasElement {
    return this.canvasEl;
  }

  storeBounds(): [number, number, number, number] {
    return this.store.bounds;
  }

  /** Canvas size in CSS pixels. */
  size(): { width: number; height: number } {
    return {
      width: this.container.clientWidth || this.canvasEl.clientWidth || 800,
      height: this.container.clientHeight || this.canvasEl.clientHeight || 600
    };
  }

  /** deck.gl's own frame breakdown, for diagnosing where time actually goes. */
  metrics(): Record<string, number> {
    return { ...((this.deck as unknown as { metrics: Record<string, number> }).metrics ?? {}) };
  }

  /** How many times the chunk layers have actually been reconstructed. */
  layerRebuilds(): number {
    return this.rebuildCount;
  }

  /** Selection highlight and filter, expressed the way the current blend mode needs. */
  private dimOptions(): DimOptions {
    // In translucent mode the highlight is applied afterwards via alpha, so the
    // colour pass leaves the hue alone.
    return {
      mask: this.blend ? null : this.currentMask,
      factor: this.blend ? 1 : this.dimFactor,
      background: this.background,
      visible: this.visible
    };
  }

  /** The single writer of `store.color`. */
  private repaintColors(from: number): void {
    const dim = this.dimOptions();
    if (!this.colorField) {
      // A dataset can carry coordinates and nothing else; draw it in the
      // theme's default point colour, which is tested to read on its background.
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
    if (this.store.loadedCount <= this.coloredUpTo) return;
    this.repaintColors(this.coloredUpTo);
    this.render();
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
      applySelectionMask(this.store.color, mask, 28, 255, this.store.loadedCount, this.visible);
      this.colorVersion++;
      this.render();
      return;
    }
    this.setColorBy(this.colorField, this.colorKind, this.ramp, 0);
  }

  /**
   * Legend filter: 0 hides a cell. Null shows every cell. Pass
   * `repaint = false` when a selection change is about to repaint anyway, so
   * one filter click costs one pass over the colour buffer, not two.
   */
  setVisibility(visible: Uint8Array | null, repaint = true): void {
    this.visible = visible;
    if (repaint) this.setColorBy(this.colorField, this.colorKind, this.ramp, 0);
  }

  /** Theme change: new background for the canvas, the dimming and the inset. */
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

  /** Replaces one named overlay. Slots stack in a fixed order (see OVERLAY_ORDER). */
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

  /** Shows, moves or (with null) removes the foreground inset view. */
  setInset(spec: InsetSpec | null): void {
    this.inset = spec;
    this.deck.setProps({ views: this.views() });
    this.render();
    this.opts.onInsetChange?.();
  }

  /** The inset camera's zoom, or null while no zoom or overview inset is drawn. */
  insetZoom(): number | null {
    return this.inset ? this.inset.zoom : null;
  }

  /** Disables deck.gl's pan/zoom controller while a lasso is being drawn. */
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

  /**
   * Animates the view to a target over `ms`, letting deck.gl drive the frames.
   *
   * The benchmark uses this rather than moving the camera itself each tick, so
   * the frame rate it records is the renderer's, not the caller's.
   */
  panTo(target: [number, number], ms: number): void {
    this.viewState = { ...withoutAxisZoom(this.viewState), target: [target[0], target[1], 0] };
    this.pendingTransition = ms > 0 ? { duration: ms, interpolator: new LinearInterpolator(['target']) } : null;
    this.render();
    this.opts.onViewStateChange?.(this.viewState);
  }

  private viewport(id = MAIN_VIEW): { project: (p: number[]) => number[]; unproject: (p: number[]) => number[] } | undefined {
    // deck.gl asserts if asked for viewports before its device has
    // initialised, which a click in the first frames after load can do.
    try {
      return this.deck.getViewports().find(v => v.id === id) as never;
    } catch {
      return undefined;
    }
  }

  /** Pixel coordinates to world coordinates, for lasso capture and clicks. */
  screenToWorld(px: number, py: number): [number, number] {
    const vp = this.viewport();
    // NaN, not the origin: callers must not act on a point that does not exist yet.
    if (!vp) return [NaN, NaN];
    const [x, y] = vp.unproject([px, py]);
    return [x, y];
  }

  /** World coordinates to canvas pixels, for anchoring DOM to data. */
  worldToScreen(x: number, y: number): [number, number] {
    const vp = this.viewport();
    if (!vp) return [NaN, NaN];
    const [px, py] = vp.project([x, y]);
    return [px, py];
  }

  /** World to pixels inside the inset (relative to the inset's top-left). */
  insetWorldToScreen(x: number, y: number): [number, number] | null {
    const vp = this.viewport(INSET_VIEW);
    if (!vp || !this.inset) return null;
    const [px, py] = vp.project([x, y]);
    return [px, py];
  }

  /** Pixels inside the inset to world coordinates. */
  insetScreenToWorld(px: number, py: number): [number, number] | null {
    const vp = this.viewport(INSET_VIEW);
    if (!vp || !this.inset) return null;
    const [x, y] = vp.unproject([px, py]);
    return [x, y];
  }

  /**
   * A lost WebGL context blanks the canvas. Every buffer can be rebuilt from
   * the typed arrays we still hold, so the recovery is simply to re-render
   * rather than to reload the dataset.
   */
  /** The only handle deck.gl's callbacks hold; emptied by `destroy`. */
  private live: { self: ScatterCanvas | null } = { self: this };

  private onContextLost = (ev: Event): void => {
    ev.preventDefault();
    console.warn('WebGL context lost; will restore from the CPU-side arrays');
  };

  private onContextRestored = (): void => {
    this.colorVersion++;
    this.render();
  };

  private installContextLossRecovery(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  destroy(): void {
    // Release what deck.gl would otherwise keep: its layers (which hold the
    // cell arrays) and, below, the way back to this object.
    this.deck.setProps({ layers: [] });
    this.chunkAttributes.clear();
    this.cachedPointLayers = [];
    this.overlays.clear();
    this.deck.finalize();
    this.live.self = null;
    // deck.gl also remembers the last pointer event it saw, and an event's
    // path lists the page elements it crossed, with their click handlers. That
    // would keep this view's toolbar, and through it the view, alive. These are
    // deck.gl internals, so the assignments are harmless if they ever change.
    const internals = this.deck as unknown as {
      _pickRequest?: { event?: unknown };
      _lastPointerDownInfo?: unknown;
      _lastPointerDownInfoPromise?: unknown;
    };
    if (internals._pickRequest) internals._pickRequest.event = null;
    internals._lastPointerDownInfo = null;
    internals._lastPointerDownInfoPromise = null;
    // The graphics library keeps hold of the canvas after `finalize` (a
    // device-pixel-ratio media-query listener still points at it), so the
    // canvas can outlive this object. These listeners must not point back at
    // it, or the whole view and every cell array would be kept alive with it.
    this.canvasEl.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvasEl.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.canvasEl.remove();
  }
}
