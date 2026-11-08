import { esc } from './escape';

/** Inputs that take no typed text, so Escape inside them means nothing. */
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

/**
 * Whether a key event's target is somewhere the user types: a text box, a
 * textarea, a select or editable content. Escape there belongs to that field.
 * A slider or radio button is not one, so after changing k or the metric the
 * Escape key still closes the card.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  return target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
}

export interface InfoCardHandle {
  readonly el: HTMLElement;
  /**
   * Shows the card next to a world-space point. `bodyHtml` must already be
   * escaped; the title is escaped here.
   */
  show: (title: string, bodyHtml: string, anchor: [number, number]) => void;
  /** Re-places the card after the view moved, keeping it beside its anchor. */
  reposition: () => void;
  hide: () => void;
  isOpen: () => boolean;
  destroy: () => void;
}

export interface InfoCardOptions {
  /** World to canvas pixels. */
  project: (x: number, y: number) => [number, number];
  /** Called when the user closes the card (× or Escape). */
  onClose?: () => void;
  label: string;
  className?: string;
}

/**
 * A pinned details card, anchored to a point in the data.
 *
 * This replaces the hover tooltip the client found distracting: it appears
 * only on click, at the clicked point, and stays put while the pointer moves.
 * It follows its anchor when the view pans or zooms, and flips to the other
 * side near the canvas edge so it never pushes itself out of view.
 */
export function createInfoCard(host: HTMLElement, opts: InfoCardOptions): InfoCardHandle {
  const el = document.createElement('section');
  el.className = `cell-card ${opts.className ?? ''}`.trim();
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', opts.label);
  host.appendChild(el);

  let anchor: [number, number] | null = null;

  const place = (): void => {
    if (!anchor) return;
    const [px, py] = opts.project(anchor[0], anchor[1]);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 12;
    const left = px + gap + w > host.clientWidth ? px - w - gap : px + gap;
    const top = py + gap + h > host.clientHeight ? py - h - gap : py + gap;
    el.style.left = `${Math.max(4, Math.min(left, host.clientWidth - w - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(top, host.clientHeight - h - 4))}px`;
  };

  const close = (): void => {
    if (el.hidden) return;
    handle.hide();
    opts.onClose?.();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || el.hidden || ev.defaultPrevented) return;
    // Escape in a text field (legend search, chat) belongs to that field.
    if (isTextEntry(ev.target)) return;
    close();
  };
  window.addEventListener('keydown', onKey);
  el.addEventListener('click', ev => {
    if ((ev.target as HTMLElement).closest('.close')) close();
  });
  // Clicks inside the card must not fall through to the plot as a "click on
  // empty space", which would close it again.
  el.addEventListener('pointerdown', ev => ev.stopPropagation());

  const handle: InfoCardHandle = {
    el,
    show(title, bodyHtml, at) {
      anchor = at;
      el.innerHTML =
        `<header><span class="title">${esc(title)}</span>` +
        `<button class="close" aria-label="Close" title="Close (Esc)">×</button></header>${bodyHtml}`;
      el.hidden = false;
      place();
    },
    reposition: place,
    hide() {
      el.hidden = true;
      anchor = null;
    },
    isOpen: () => !el.hidden,
    destroy() {
      window.removeEventListener('keydown', onKey);
      el.remove();
    }
  };
  return handle;
}
