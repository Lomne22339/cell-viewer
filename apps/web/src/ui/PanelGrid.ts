import { assignSlots } from '@core/protocol/panels';
import { esc } from './escape';

export interface PanelSpec {
  /** Lower-case letters and digits; becomes a grid-area name, so `main` and `rail*` are reserved. */
  id: string;
  title: string;
}

export interface PanelGridOptions {
  /** A panel's body changed size (an expand or collapse, or a window resize). */
  onResize?: (id: string) => void;
  /** The expanded panel changed; null means none is expanded. */
  onExpand?: (id: string | null) => void;
}

export interface PanelGridHandle {
  /** Where a panel's content goes. */
  body: (id: string) => HTMLElement;
  /** Room in a panel's header for the owner's own controls. */
  header: (id: string) => HTMLElement;
  expand: (id: string | null) => void;
  expanded: () => string | null;
  destroy: () => void;
}

const VALID_ID = /^[a-z][a-z0-9]*$/;

/**
 * Three panels in a grid, any of which can take the main area.
 *
 * Expanding gives one panel the large cell and moves the other two onto a rail
 * of thumbnails. The panels are never moved in the DOM, only given another
 * grid-area, so a WebGL canvas, an SVG or a conversation keeps its state
 * through an expand and a collapse. A thumbnail is live but not interactive:
 * clicking anywhere on it expands it. Escape collapses.
 *
 * The owner learns of size changes through `onResize`, driven by a
 * ResizeObserver, because a canvas does not notice its container changing on
 * its own.
 */
export function createPanelGrid(root: HTMLElement, panels: PanelSpec[], opts: PanelGridOptions = {}): PanelGridHandle {
  const order = panels.map(p => p.id);
  for (const id of order) {
    if (!VALID_ID.test(id) || id === 'main' || id.startsWith('rail')) throw new Error(`invalid panel id "${id}"`);
  }
  assignSlots(order, null); // rejects duplicates up front

  const grid = document.createElement('div');
  grid.className = 'pg';
  grid.dataset.expanded = '';
  grid.innerHTML = panels
    .map(
      p =>
        `<section class="pg-panel" data-panel="${esc(p.id)}" aria-label="${esc(p.title)}">` +
        `<header class="pg-head"><h2>${esc(p.title)}</h2><span class="pg-extra"></span>` +
        `<button class="btn btn-small pg-expand" aria-expanded="false" ` +
        `aria-label="Expand ${esc(p.title)}" title="Expand to the main view">⤢</button></header>` +
        `<div class="pg-body"></div>` +
        `<button class="pg-restore" aria-label="Show ${esc(p.title)} in the main view" tabindex="-1"></button>` +
        `</section>`
    )
    .join('');
  root.appendChild(grid);

  const panel = (id: string): HTMLElement => grid.querySelector<HTMLElement>(`[data-panel="${id}"]`)!;
  let current: string | null = null;

  const layout = (): void => {
    const slots = assignSlots(order, current);
    const rails = order.length - 1;
    if (current === null) {
      // The first panel gets the left column, the rest share the right.
      grid.style.gridTemplateColumns = order.length === 3 ? '3fr 2fr' : `repeat(${order.length}, 1fr)`;
      grid.style.gridTemplateRows = order.length === 3 ? '1fr 1fr' : '1fr';
      grid.style.gridTemplateAreas =
        order.length === 3
          ? `"${order[0]} ${order[1]}" "${order[0]} ${order[2]}"`
          : `"${order.join(' ')}"`;
    } else {
      grid.style.gridTemplateColumns = '1fr 240px';
      grid.style.gridTemplateRows = `repeat(${rails}, 1fr)`;
      grid.style.gridTemplateAreas = Array.from({ length: rails }, (_, i) => `"main rail${i + 1}"`).join(' ');
    }
    for (const id of order) {
      const el = panel(id);
      el.style.gridArea = slots[id];
      const isMain = id === current;
      const isRail = current !== null && !isMain;
      el.classList.toggle('main', isMain);
      el.classList.toggle('rail', isRail);
      const button = el.querySelector<HTMLButtonElement>('.pg-expand')!;
      button.setAttribute('aria-expanded', String(isMain));
      const title = panels.find(p => p.id === id)!.title;
      button.setAttribute('aria-label', `${isMain ? 'Collapse' : 'Expand'} ${title}`);
      button.title = isMain ? 'Back to the overview' : 'Expand to the main view';
      button.textContent = isMain ? '⤡' : '⤢';
      // Thumbnails are not interactive: the whole tile is one "expand" target.
      el.querySelector<HTMLElement>('.pg-restore')!.tabIndex = isRail ? 0 : -1;
      el.querySelector<HTMLElement>('.pg-body')!.toggleAttribute('inert', isRail);
    }
    grid.dataset.expanded = current ?? '';
  };

  const expand = (id: string | null): void => {
    const next = id !== null && order.includes(id) ? id : null;
    if (next === current) return;
    current = next;
    layout();
    opts.onExpand?.(current);
  };

  grid.addEventListener('click', ev => {
    const target = ev.target as HTMLElement;
    const section = target.closest<HTMLElement>('[data-panel]');
    if (!section) return;
    const id = section.dataset.panel!;
    if (target.closest('.pg-restore')) expand(id);
    else if (target.closest('.pg-expand')) expand(current === id ? null : id);
  });

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || current === null || ev.defaultPrevented) return;
    const t = ev.target as HTMLElement | null;
    // Escape in a text field belongs to that field.
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    // Collapsing is all this Escape does: a details card ignores a key that is
    // already handled, so it stays open and the choice it belongs to survives.
    ev.preventDefault();
    expand(null);
  };
  window.addEventListener('keydown', onKey);

  let pending = new Set<string>();
  let frame = 0;
  const observer = new ResizeObserver(entries => {
    for (const e of entries) {
      const id = (e.target.closest('[data-panel]') as HTMLElement | null)?.dataset.panel;
      if (id) pending.add(id);
    }
    if (frame) return;
    // One notification per frame, however many panels changed.
    frame = requestAnimationFrame(() => {
      frame = 0;
      const ids = pending;
      pending = new Set();
      for (const id of ids) opts.onResize?.(id);
    });
  });
  grid.querySelectorAll('.pg-body').forEach(b => observer.observe(b));

  layout();
  return {
    body: id => panel(id).querySelector<HTMLElement>('.pg-body')!,
    header: id => panel(id).querySelector<HTMLElement>('.pg-extra')!,
    expand,
    expanded: () => current,
    destroy() {
      window.removeEventListener('keydown', onKey);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      grid.remove();
    }
  };
}
