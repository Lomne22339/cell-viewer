import { esc } from './escape';

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  return target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
}

export interface InfoCardHandle {
  readonly el: HTMLElement;
  /** `bodyHtml` must already be escaped; the title is escaped here. */
  show: (title: string, bodyHtml: string, anchor: [number, number]) => void;
  reposition: () => void;
  hide: () => void;
  isOpen: () => boolean;
  destroy: () => void;
}

export interface InfoCardOptions {
  project: (x: number, y: number) => [number, number];
  onClose?: () => void;
  label: string;
  className?: string;
}

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
    if (isTextEntry(ev.target)) return;
    close();
  };
  window.addEventListener('keydown', onKey);
  el.addEventListener('click', ev => {
    if ((ev.target as HTMLElement).closest('.close')) close();
  });
  // Clicks inside the card must not reach the plot as a click on empty space (that closes it).
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
