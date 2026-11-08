export interface ClickOptions {
  /** Maximum pointer travel, in CSS pixels, for a press to count as a click. */
  tolerancePx?: number;
  /** Maximum press duration in milliseconds. */
  maxMs?: number;
}

/**
 * Distinguishes a click from a drag on the plot.
 *
 * The plot is also panned, boxed and lassoed by dragging, so a plain `click`
 * event is not enough: browsers fire one at the end of a short drag too. A
 * press counts as a click only if the pointer stays within a few pixels and
 * is released promptly — the same test deck.gl's own tap gesture uses.
 */
export class ClickDetector {
  private down: { id: number; x: number; y: number; t: number } | null = null;
  private tolerance2: number;
  private maxMs: number;

  constructor(
    private el: HTMLElement,
    private onClick: (x: number, y: number, ev: PointerEvent) => void,
    opts: ClickOptions = {}
  ) {
    const tol = opts.tolerancePx ?? 5;
    this.tolerance2 = tol * tol;
    this.maxMs = opts.maxMs ?? 600;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onCancel);
  }

  private onDown = (ev: PointerEvent): void => {
    if (ev.button !== 0 || !ev.isPrimary) return;
    this.down = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, t: performance.now() };
  };

  private onUp = (ev: PointerEvent): void => {
    const d = this.down;
    this.down = null;
    if (!d || d.id !== ev.pointerId) return;
    const dx = ev.clientX - d.x;
    const dy = ev.clientY - d.y;
    if (dx * dx + dy * dy > this.tolerance2 || performance.now() - d.t > this.maxMs) return;
    const r = this.el.getBoundingClientRect();
    this.onClick(ev.clientX - r.left, ev.clientY - r.top, ev);
  };

  private onCancel = (): void => {
    this.down = null;
  };

  destroy(): void {
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('pointercancel', this.onCancel);
  }
}
