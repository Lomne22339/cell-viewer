import type { CellStore } from '@core/data/schema';
import {
  clampRect,
  connectorLines,
  fitBounds,
  magnification,
  rectsIntersect,
  regionAround,
  type Bounds,
  type ScreenRect
} from '@core/inset/geometry';
import type { ScatterCanvas } from '../views/ScatterCanvas';

export type InsetMode = 'zoom' | 'overview' | 'anatomy' | 'image';

const ZOOM_CHUNKS = 4;

const STORAGE_KEY = 'cellviewer.inset';
const HEADER_PX = 27;
const MIN_W = 200;
const MIN_H = 150;

export interface InsetDeps {
  host: HTMLElement;
  canvas: ScatterCanvas;
  store: CellStore;
  mountAnatomy: (el: HTMLElement) => () => void;
  onOpenChange?: (open: boolean) => void;
}

interface Persisted {
  frame: ScreenRect;
  mode: InsetMode;
}

function loadPersisted(): Partial<Persisted> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Persisted>;
  } catch {
    return {};
  }
}

/** Foreground inset: zoom, overview or anatomy; a second deck.gl view on the shared GPU buffers. */
export class InsetController {
  private frameEl: HTMLElement;
  private bodyEl: HTMLElement;
  private magEl: HTMLElement;
  private markerEl: HTMLElement;
  private viewportEl: HTMLElement;
  private svg: SVGSVGElement;
  private frame: ScreenRect;
  private mode: InsetMode;
  private open = false;
  private body: ScreenRect | null = null;
  private regionCenter: [number, number] = [0, 0];
  private regionWidth = 1;
  private unmountAnatomy: (() => void) | null = null;
  private imageEl: HTMLElement | null = null;
  private imageUrl: string | null = null;
  private drag: null | {
    kind: 'frame' | 'resize' | 'marker' | 'marker-resize' | 'overview';
    id: number;
    x: number;
    y: number;
    frame: ScreenRect;
    center: [number, number];
    world: [number, number];
  } = null;

  constructor(private deps: InsetDeps) {
    const saved = loadPersisted();
    const { width, height } = deps.canvas.size();
    this.frame = saved.frame ?? { x: width - 336, y: 16, w: 320, h: 240 };
    this.mode = saved.mode ?? 'zoom';

    this.frameEl = document.createElement('div');
    this.frameEl.className = 'inset-frame';
    this.frameEl.hidden = true;
    this.frameEl.setAttribute('role', 'region');
    this.frameEl.setAttribute('aria-label', 'Inset');
    this.frameEl.innerHTML = `
      <header title="Drag to move">
        <span class="title">Inset</span><span class="mag"></span>
        <span class="modes" role="group" aria-label="Inset content">
          <button data-mode="zoom" title="Magnified region of the plot">Zoom</button>
          <button data-mode="overview" title="Whole dataset; click to navigate">Overview</button>
          <button data-mode="anatomy" title="Segmented anatomy figure">Anatomy</button>
          <button data-mode="image" title="Your own image, e.g. a tissue section">Image</button>
        </span>
        <button class="close" aria-label="Close inset" title="Close">×</button>
      </header>
      <div class="inset-body"><div class="inset-viewport" hidden></div></div>
      <div class="inset-resize" title="Drag to resize"></div>`;
    this.bodyEl = this.frameEl.querySelector('.inset-body')!;
    this.magEl = this.frameEl.querySelector('.mag')!;
    this.viewportEl = this.frameEl.querySelector('.inset-viewport')!;

    this.markerEl = document.createElement('div');
    this.markerEl.className = 'inset-marker';
    this.markerEl.hidden = true;
    this.markerEl.innerHTML =
      `<span class="grip" title="Drag to move the inset region">inset region</span>` +
      `<span class="corner" title="Drag to resize the inset region"></span>`;

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'inset-connectors');
    this.svg.innerHTML = '<line/><line/>';
    this.svg.style.display = 'none';

    deps.host.append(this.svg, this.markerEl, this.frameEl);
    this.frameEl.addEventListener('pointerdown', this.onFramePointerDown);
    this.frameEl.addEventListener('click', this.onFrameClick);
    this.markerEl.addEventListener('pointerdown', this.onMarkerPointerDown);
    this.bodyEl.addEventListener('wheel', this.onWheel, { passive: false });
    this.bodyEl.addEventListener('dblclick', this.onBodyDoubleClick);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('resize', this.onResize);
  }

  isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(mode: InsetMode = this.mode): void {
    if (!this.open) {
      const { width, height } = this.deps.canvas.size();
      const a = this.deps.canvas.screenToWorld(width * 0.44, height * 0.5);
      const b = this.deps.canvas.screenToWorld(width * 0.56, height * 0.5);
      const center = this.deps.canvas.screenToWorld(width / 2, height / 2);
      const [x0, y0, x1, y1] = this.deps.store.bounds;
      const ready = Number.isFinite(center[0]) && Number.isFinite(a[0]) && Number.isFinite(b[0]);
      this.regionCenter = ready ? center : [(x0 + x1) / 2, (y0 + y1) / 2];
      this.regionWidth = ready ? Math.max(Math.abs(b[0] - a[0]), 1e-6) : (x1 - x0) / 8;
    }
    this.open = true;
    this.frameEl.hidden = false;
    this.setMode(mode);
    this.deps.onOpenChange?.(true);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.frameEl.hidden = true;
    this.markerEl.hidden = true;
    this.svg.style.display = 'none';
    this.unmountAnatomy?.();
    this.unmountAnatomy = null;
    this.deps.canvas.setInset(null);
    this.deps.onOpenChange?.(false);
  }

  setMode(mode: InsetMode): void {
    this.mode = mode;
    this.persist();
    this.frameEl.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    });
    this.bodyEl.classList.toggle('anatomy', mode === 'anatomy');
    this.bodyEl.classList.toggle('image', mode === 'image');
    if (mode === 'image') this.mountImage();
    else if (this.imageEl) {
      this.imageEl.remove();
      this.imageEl = null;
    }
    if (mode === 'anatomy') {
      if (!this.unmountAnatomy) {
        const holder = document.createElement('div');
        this.bodyEl.appendChild(holder);
        const unmount = this.deps.mountAnatomy(holder);
        this.unmountAnatomy = () => {
          unmount();
          holder.remove();
        };
      }
    } else if (this.unmountAnatomy) {
      this.unmountAnatomy();
      this.unmountAnatomy = null;
    }
    this.layout();
  }

  onViewChanged(): void {
    if (this.open) this.positionOverlays();
  }

  private bodyRect(): ScreenRect {
    if (this.body) return this.body;
    const f = this.frame;
    return { x: f.x + 1, y: f.y + HEADER_PX, w: Math.max(1, f.w - 2), h: Math.max(1, f.h - HEADER_PX - 1) };
  }

  private measureBody(): void {
    const host = this.deps.host.getBoundingClientRect();
    const b = this.bodyEl.getBoundingClientRect();
    this.body = b.width > 0 && b.height > 0
      ? { x: b.left - host.left, y: b.top - host.top, w: b.width, h: b.height }
      : null;
  }

  private region(): Bounds {
    const b = this.bodyRect();
    return regionAround(this.regionCenter, this.regionWidth, b.h / b.w);
  }

  private layout(): void {
    if (!this.open) return;
    const { width, height } = this.deps.canvas.size();
    this.frame = clampRect(this.frame, width, height, MIN_W, MIN_H);
    const f = this.frame;
    Object.assign(this.frameEl.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px` });
    this.measureBody();

    const body = this.bodyRect();
    if (this.mode === 'anatomy' || this.mode === 'image') {
      this.deps.canvas.setInset(null);
      this.magEl.textContent = '';
    } else {
      const fit =
        this.mode === 'zoom'
          ? fitBounds(this.region(), body.w, body.h)
          : fitBounds(this.deps.store.bounds, body.w, body.h, 1.04);
      this.deps.canvas.setInset({
        rect: body,
        target: fit.target,
        zoom: fit.zoom,
        chunks: this.mode === 'zoom' ? ZOOM_CHUNKS : 1
      });
      this.magEl.textContent =
        this.mode === 'zoom'
          ? `${magnification(this.deps.canvas.viewState.zoom, fit.zoom).toFixed(1)}×`
          : '';
    }
    this.positionOverlays();
  }

  private positionOverlays(): void {
    const zoomMode = this.open && this.mode === 'zoom';
    this.markerEl.hidden = !zoomMode;
    this.viewportEl.hidden = !(this.open && this.mode === 'overview');

    if (zoomMode) {
      const [x0, y0, x1, y1] = this.region();
      const a = this.deps.canvas.worldToScreen(x0, y0);
      const b = this.deps.canvas.worldToScreen(x1, y1);
      const m: ScreenRect = {
        x: Math.min(a[0], b[0]),
        y: Math.min(a[1], b[1]),
        w: Math.abs(b[0] - a[0]),
        h: Math.abs(b[1] - a[1])
      };
      Object.assign(this.markerEl.style, { left: `${m.x}px`, top: `${m.y}px`, width: `${m.w}px`, height: `${m.h}px` });
      this.markerEl.hidden = rectsIntersect(m, this.frame);
      const lines = connectorLines(m, this.frame);
      this.svg.style.display = lines.length ? '' : 'none';
      const els = this.svg.querySelectorAll('line');
      lines.forEach(([p, q], i) => {
        els[i].setAttribute('x1', String(p[0]));
        els[i].setAttribute('y1', String(p[1]));
        els[i].setAttribute('x2', String(q[0]));
        els[i].setAttribute('y2', String(q[1]));
      });
      const fit = fitBounds(this.region(), this.bodyRect().w, this.bodyRect().h);
      this.magEl.textContent = `${magnification(this.deps.canvas.viewState.zoom, fit.zoom).toFixed(1)}×`;
    } else {
      this.svg.style.display = 'none';
    }

    if (this.open && this.mode === 'overview') {
      const { width, height } = this.deps.canvas.size();
      const tl = this.deps.canvas.screenToWorld(0, 0);
      const br = this.deps.canvas.screenToWorld(width, height);
      const p = this.deps.canvas.insetWorldToScreen(tl[0], tl[1]);
      const q = this.deps.canvas.insetWorldToScreen(br[0], br[1]);
      if (p && q) {
        const body = this.bodyRect();
        const x = Math.max(0, Math.min(p[0], q[0]));
        const y = Math.max(0, Math.min(p[1], q[1]));
        const w = Math.min(body.w, Math.max(p[0], q[0])) - x;
        const h = Math.min(body.h, Math.max(p[1], q[1])) - y;
        Object.assign(this.viewportEl.style, {
          left: `${x}px`,
          top: `${y}px`,
          width: `${Math.max(2, w)}px`,
          height: `${Math.max(2, h)}px`
        });
      }
    }
  }

  /** Image mode: a user-chosen picture in the foreground, kept in this page and never uploaded. */
  private mountImage(): void {
    if (this.imageEl) return;
    const el = document.createElement('div');
    el.className = 'inset-image';
    el.innerHTML =
      `<img alt="Inset image" hidden>` +
      `<label class="inset-drop"><span class="drop-text">Drop an image here, or </span>` +
      `<span class="btn-link">choose a file</span>` +
      `<input type="file" accept="image/*" hidden></label>`;
    const img = el.querySelector('img')!;
    const drop = el.querySelector<HTMLElement>('.inset-drop')!;
    const input = el.querySelector<HTMLInputElement>('input')!;
    const present = (): void => {
      img.src = this.imageUrl!;
      img.hidden = false;
      drop.classList.add('has-image');
      drop.querySelector('.drop-text')!.textContent = '';
      drop.querySelector('.btn-link')!.textContent = 'Replace image';
    };
    const show = (file: File | undefined | null): void => {
      if (!file || !file.type.startsWith('image/')) return;
      if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
      this.imageUrl = URL.createObjectURL(file);
      present();
    };
    if (this.imageUrl) present();
    input.addEventListener('change', () => show(input.files?.[0]));
    el.addEventListener('dragover', ev => ev.preventDefault());
    el.addEventListener('drop', ev => {
      ev.preventDefault();
      show(ev.dataTransfer?.files?.[0]);
    });
    this.bodyEl.appendChild(el);
    this.imageEl = el;
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ frame: this.frame, mode: this.mode }));
    } catch {
      /* not persisted */
    }
  }

  private localPoint(ev: PointerEvent | WheelEvent | MouseEvent): [number, number] {
    const r = this.deps.host.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  private onFrameClick = (ev: MouseEvent): void => {
    const t = ev.target as HTMLElement;
    const modeBtn = t.closest<HTMLButtonElement>('[data-mode]');
    if (modeBtn) this.setMode(modeBtn.dataset.mode as InsetMode);
    else if (t.closest('.close')) this.close();
  };

  private onFramePointerDown = (ev: PointerEvent): void => {
    const t = ev.target as HTMLElement;
    ev.stopPropagation();
    if (t.closest('button') || ev.button !== 0) return;
    const [x, y] = this.localPoint(ev);
    const base = { id: ev.pointerId, x, y, frame: { ...this.frame }, center: this.regionCenter, world: [0, 0] as [number, number] };
    if (t.closest('.inset-resize')) this.drag = { kind: 'resize', ...base };
    else if (t.closest('header')) this.drag = { kind: 'frame', ...base };
    else if (this.mode === 'overview' && t.closest('.inset-body')) {
      this.drag = { kind: 'overview', ...base };
      this.recenterFromOverview(x, y);
    } else return;
    ev.preventDefault();
  };

  private onMarkerPointerDown = (ev: PointerEvent): void => {
    const t = ev.target as HTMLElement;
    if (ev.button !== 0 || !(t.closest('.grip') || t.closest('.corner'))) return;
    ev.stopPropagation();
    ev.preventDefault();
    const [x, y] = this.localPoint(ev);
    this.drag = {
      kind: t.closest('.corner') ? 'marker-resize' : 'marker',
      id: ev.pointerId,
      x,
      y,
      frame: { ...this.frame },
      center: [...this.regionCenter] as [number, number],
      world: this.deps.canvas.screenToWorld(x, y)
    };
  };

  private onPointerMove = (ev: PointerEvent): void => {
    const d = this.drag;
    if (!d || d.id !== ev.pointerId) return;
    const [x, y] = this.localPoint(ev);
    if (d.kind === 'frame') {
      this.frame = { ...d.frame, x: d.frame.x + x - d.x, y: d.frame.y + y - d.y };
      this.layout();
    } else if (d.kind === 'resize') {
      this.frame = { ...d.frame, w: Math.max(MIN_W, d.frame.w + x - d.x), h: Math.max(MIN_H, d.frame.h + y - d.y) };
      this.layout();
    } else if (d.kind === 'marker') {
      const w = this.deps.canvas.screenToWorld(x, y);
      this.regionCenter = [d.center[0] + w[0] - d.world[0], d.center[1] + w[1] - d.world[1]];
      this.layout();
    } else if (d.kind === 'marker-resize') {
      const w = this.deps.canvas.screenToWorld(x, y);
      this.regionWidth = Math.max(1e-6, 2 * Math.abs(w[0] - this.regionCenter[0]));
      this.layout();
    } else if (d.kind === 'overview') {
      this.recenterFromOverview(x, y);
    }
  };

  private onPointerUp = (ev: PointerEvent): void => {
    if (!this.drag || this.drag.id !== ev.pointerId) return;
    this.drag = null;
    this.persist();
  };

  private recenterFromOverview(x: number, y: number): void {
    const body = this.bodyRect();
    const w = this.deps.canvas.insetScreenToWorld(x - body.x, y - body.y);
    if (w) this.deps.canvas.panTo(w, 0);
  }

  private onWheel = (ev: WheelEvent): void => {
    if (this.mode !== 'zoom') return;
    ev.preventDefault();
    this.regionWidth = Math.max(1e-6, this.regionWidth * Math.pow(1.0015, ev.deltaY));
    this.layout();
  };

  private onBodyDoubleClick = (): void => {
    if (this.mode === 'zoom') this.deps.canvas.fitBounds(this.region());
  };

  private onResize = (): void => {
    this.layout();
  };

  destroy(): void {
    this.close();
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('resize', this.onResize);
    this.frameEl.remove();
    this.markerEl.remove();
    this.svg.remove();
  }
}
