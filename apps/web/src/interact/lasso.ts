import { PolygonLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { normalizeRect, simplifyPath } from '@core/select/geometry';
import type { QueryShape } from '@core/select/worker';
import type { ScatterCanvas } from '../views/ScatterCanvas';

export type Mode = 'pan' | 'box' | 'lasso';

export interface LassoOptions {
  onComplete: (shape: QueryShape) => void;
  onCancel?: () => void;
}

/**
 * Captures a box drag or a freehand lasso in screen space, converts it to
 * world space, and hands the resulting shape to the selection worker.
 *
 * The in-progress outline is drawn as a deck.gl overlay layer rather than as
 * a DOM element, so it stays locked to the data if the view moves mid-drag
 * instead of sliding away from the cells it encloses.
 */
export class LassoController {
  mode: Mode = 'pan';
  private drawing = false;
  private screenPts: number[] = [];
  private el: HTMLElement;
  private previewFrame = 0;

  constructor(
    private canvas: ScatterCanvas,
    private opts: LassoOptions
  ) {
    this.el = canvas.element();
    this.el.addEventListener('pointerdown', this.onDown);
    this.el.addEventListener('pointermove', this.onMove);
    this.el.addEventListener('pointerup', this.onUp);
    window.addEventListener('keydown', this.onKey);
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.drawing = false;
    this.screenPts = [];
    this.canvas.setInteractive(mode === 'pan');
    this.canvas.setSelectionOverlay([]);
    this.el.style.cursor = mode === 'pan' ? 'grab' : 'crosshair';
  }

  private local(ev: PointerEvent): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  private onDown = (ev: PointerEvent): void => {
    if (this.mode === 'pan' || ev.button !== 0) return;
    ev.preventDefault();
    try {
      // Capture keeps the drag alive if the pointer leaves the canvas. Some
      // inputs refuse it; the drag is still worth having without it.
      this.el.setPointerCapture(ev.pointerId);
    } catch {
      /* not fatal */
    }
    this.drawing = true;
    this.screenPts = this.local(ev);
  };

  private onMove = (ev: PointerEvent): void => {
    if (!this.drawing) return;
    const [x, y] = this.local(ev);
    if (this.mode === 'box') {
      this.screenPts = [this.screenPts[0], this.screenPts[1], x, y];
    } else {
      const n = this.screenPts.length;
      // Skip sub-pixel moves; they add vertices without adding shape.
      const dx = x - this.screenPts[n - 2];
      const dy = y - this.screenPts[n - 1];
      if (dx * dx + dy * dy < 4) return;
      this.screenPts.push(x, y);
    }
    this.schedulePreview();
  };

  /**
   * Coalesces preview redraws to one per animation frame.
   *
   * A fast drag emits pointer events faster than the compositor paints, and
   * redrawing per event means the outline lags behind the cursor rather than
   * leading it.
   */
  private schedulePreview(): void {
    if (this.previewFrame) return;
    this.previewFrame = requestAnimationFrame(() => {
      this.previewFrame = 0;
      if (this.drawing) this.canvas.setSelectionOverlay(this.previewLayers());
    });
  }

  private onUp = (ev: PointerEvent): void => {
    if (!this.drawing) return;
    this.drawing = false;
    if (this.previewFrame) {
      cancelAnimationFrame(this.previewFrame);
      this.previewFrame = 0;
    }
    try {
      this.el.releasePointerCapture(ev.pointerId);
    } catch {
      // The pointer may already be released; not worth failing a selection over.
    }
    const shape = this.toWorldShape();
    this.canvas.setSelectionOverlay([]);
    this.screenPts = [];
    if (!shape) {
      this.opts.onCancel?.();
      return;
    }
    this.opts.onComplete(shape);
  };

  private onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return;
    this.drawing = false;
    this.screenPts = [];
    this.canvas.setSelectionOverlay([]);
    this.opts.onCancel?.();
  };

  private worldRing(): [number, number][] {
    if (this.mode === 'box' && this.screenPts.length === 4) {
      const [x0, y0, x1, y1] = normalizeRect([
        this.screenPts[0],
        this.screenPts[1],
        this.screenPts[2],
        this.screenPts[3]
      ]);
      return [
        this.canvas.screenToWorld(x0, y0),
        this.canvas.screenToWorld(x1, y0),
        this.canvas.screenToWorld(x1, y1),
        this.canvas.screenToWorld(x0, y1)
      ];
    }
    const simplified = simplifyPath(this.screenPts, 2);
    const ring: [number, number][] = [];
    for (let i = 0; i < simplified.length; i += 2) {
      ring.push(this.canvas.screenToWorld(simplified[i], simplified[i + 1]));
    }
    return ring;
  }

  private previewLayers(): Layer[] {
    const ring = this.worldRing();
    if (ring.length < 2) return [];
    return [
      new PolygonLayer({
        id: 'lasso-preview',
        data: [{ polygon: [...ring, ring[0]] }],
        getPolygon: (d: { polygon: [number, number][] }) => d.polygon,
        filled: true,
        getFillColor: [90, 160, 255, 40],
        stroked: true,
        getLineColor: [120, 190, 255, 220],
        getLineWidth: 1.5,
        lineWidthUnits: 'pixels',
        pickable: false
      })
    ];
  }

  private toWorldShape(): QueryShape | null {
    const ring = this.worldRing();
    if (ring.length < 3) return null;
    if (this.mode === 'box') {
      const xs = ring.map(p => p[0]);
      const ys = ring.map(p => p[1]);
      return {
        kind: 'rect',
        rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
      };
    }
    const flat = new Float64Array(ring.length * 2);
    ring.forEach((p, i) => {
      flat[i * 2] = p[0];
      flat[i * 2 + 1] = p[1];
    });
    return { kind: 'poly', poly: flat };
  }

  destroy(): void {
    if (this.previewFrame) cancelAnimationFrame(this.previewFrame);
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('pointermove', this.onMove);
    this.el.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('keydown', this.onKey);
  }
}
