import type { CellStore } from '@core/data/schema';
import { legendEntries, type LegendEntry } from '@core/color/recolor';
import { rampFor } from '@core/color/palette';
import type { CategoryFilter } from '@core/filter/categories';
import type { Rgb } from '@core/theme/themes';
import { esc } from './escape';

const SEARCH_THRESHOLD = 10;
/** How long a click waits to see if it is half of a double-click (Plotly uses 300 ms). */
const DOUBLE_CLICK_MS = 300;
const LATE_DOUBLE_CLICK_MS = 700;

export interface LegendHandle {
  update: (
    store: CellStore,
    field: string,
    kind: 'categorical' | 'numeric',
    counted?: Uint8Array | null,
    background?: Rgb,
    ramp?: string
  ) => void;
}

/** The legend and its category filter, Plotly-style: click toggles, double-click isolates. */
export function createLegend(root: HTMLElement, filter: CategoryFilter): LegendHandle {
  const box = document.createElement('div');
  box.className = 'legend';
  root.appendChild(box);

  let store: CellStore | null = null;
  let field = '';
  let kind: 'categorical' | 'numeric' = 'categorical';
  let background: Rgb | undefined;
  let ramp = 'viridis';
  let entries: (LegendEntry & { code: number; total: number })[] = [];
  let query = '';
  let pending: ReturnType<typeof setTimeout> | null = null;
  let lastToggle: { field: string; code: number; at: number } | null = null;

  const chips = (): string => {
    const active = filter.activeFields().filter(f => !(kind === 'categorical' && f === field));
    if (!active.length) return '';
    return (
      `<div class="filter-chips" aria-label="Active filters">` +
      active
        .map(
          f =>
            `<span class="filter-chip">${esc(f)}: ${filter.hiddenCodes(f).length} hidden` +
            `<button data-clear="${esc(f)}" aria-label="Clear the ${esc(f)} filter" title="Show all ${esc(f)} again">×</button></span>`
        )
        .join('') +
      `</div>`
    );
  };

  const rowsHtml = (): string => {
    const q = query.trim().toLowerCase();
    const shown = q ? entries.filter(e => e.label.toLowerCase().includes(q)) : entries;
    if (!shown.length) return `<div class="legend-more">No level matches “${esc(query)}”.</div>`;
    return shown
      .map(e => {
        const off = filter.isHidden(field, e.code);
        const label = esc(e.label);
        return (
          `<div class="legend-item">` +
          `<button class="legend-row${off ? ' off' : ''}" data-code="${e.code}" aria-pressed="${!off}" ` +
          `title="Click to ${off ? 'show' : 'hide'} · double-click to show only this">` +
          `<i style="background:rgb(${e.rgb.join(',')})"></i><span>${label}</span>` +
          `<b>${e.count.toLocaleString()}</b></button>` +
          `<button class="legend-only" data-only data-code="${e.code}" aria-label="Show only ${label}" ` +
          `title="Show only ${label}">only</button></div>`
        );
      })
      .join('');
  };

  const shownCount = (): number => entries.filter(e => !filter.isHidden(field, e.code)).length;

  const rampGradient = (): string => {
    const r = rampFor(ramp, background);
    const steps = r.length / 3;
    const stops: string[] = [];
    for (let k = 0; k <= 8; k++) {
      const i = Math.round((k / 8) * (steps - 1)) * 3;
      stops.push(`rgb(${r[i]},${r[i + 1]},${r[i + 2]}) ${(k / 8) * 100}%`);
    }
    return `linear-gradient(90deg, ${stops.join(', ')})`;
  };

  const render = (): void => {
    if (!store || !field) {
      box.innerHTML = chips();
      return;
    }
    if (kind === 'numeric') {
      const [lo, hi] = store.numericRange.get(field) ?? [0, 1];
      box.innerHTML =
        `<div class="legend-head"><span class="legend-title">${esc(field)}</span></div>` +
        `<div class="ramp" style="background:${rampGradient()}"></div>` +
        `<div class="ramp-labels"><span>${lo.toFixed(2)}</span><span>${hi.toFixed(2)}</span></div>` +
        chips();
      return;
    }
    box.innerHTML =
      `<div class="legend-head"><span class="legend-title">${esc(field)}</span>` +
      `<span class="muted legend-count">${shownCount()} of ${entries.length} shown</span>` +
      `<span class="legend-actions"><button class="btn-link" data-act="all">Show all</button>` +
      `<button class="btn-link" data-act="none">Hide all</button></span></div>` +
      (entries.length > SEARCH_THRESHOLD
        ? `<input class="legend-search" type="search" placeholder="Search ${entries.length} levels…" ` +
          `aria-label="Search ${esc(field)} levels" value="${esc(query)}">`
        : '') +
      `<div class="legend-list" role="group" aria-label="${esc(field)} levels">${rowsHtml()}</div>` +
      `<div class="legend-hint">Click to hide · double-click to show only one</div>` +
      chips();
  };

  const focusKey = (): string | null => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || !box.contains(el)) return null;
    if (el.classList.contains('legend-row')) return `.legend-row[data-code="${el.dataset.code}"]`;
    if (el.classList.contains('legend-only')) return `.legend-only[data-code="${el.dataset.code}"]`;
    if (el.dataset.act) return `[data-act="${el.dataset.act}"]`;
    if (el.classList.contains('legend-search')) return '.legend-search';
    return null;
  };

  const toggle = (f: string, code: number): void => {
    lastToggle = { field: f, code, at: performance.now() };
    filter.toggle(f, code);
  };

  const isolate = (f: string, code: number): void => {
    // If the first click already toggled the row (slow double-click), undo it before isolating.
    const late = lastToggle;
    if (late && late.field === f && late.code === code && performance.now() - late.at < LATE_DOUBLE_CLICK_MS) {
      filter.toggle(f, code);
    }
    lastToggle = null;
    filter.isolate(f, code);
  };

  box.addEventListener('click', ev => {
    const target = ev.target as HTMLElement;
    const clear = target.closest<HTMLButtonElement>('[data-clear]');
    if (clear) {
      filter.showAll(clear.dataset.clear!);
      return;
    }
    const act = target.closest<HTMLButtonElement>('[data-act]')?.dataset.act;
    if (act === 'all') {
      filter.showAll(field);
      return;
    }
    if (act === 'none') {
      filter.hideAll(field);
      return;
    }
    const only = target.closest<HTMLButtonElement>('[data-only]');
    if (only) {
      if (pending) clearTimeout(pending);
      pending = null;
      lastToggle = null;
      filter.isolate(field, Number(only.dataset.code));
      return;
    }
    const row = target.closest<HTMLButtonElement>('.legend-row');
    if (!row) return;
    const code = Number(row.dataset.code);
    // A second click (detail 2) turns the pending toggle into an isolate; keyboard toggles at once.
    if (ev.detail >= 2) {
      if (pending) clearTimeout(pending);
      pending = null;
      isolate(field, code);
      return;
    }
    if (ev.detail === 0) {
      toggle(field, code);
      return;
    }
    if (pending) clearTimeout(pending);
    const clickedField = field;
    pending = setTimeout(() => {
      pending = null;
      toggle(clickedField, code);
    }, DOUBLE_CLICK_MS);
  });

  box.addEventListener('input', ev => {
    const input = ev.target as HTMLInputElement;
    if (!input.classList.contains('legend-search')) return;
    query = input.value;
    const list = box.querySelector('.legend-list');
    if (list) list.innerHTML = rowsHtml();
  });

  return {
    update(s, f, k, counted = null, bg, rampName = 'viridis') {
      const sameField = f === field && s === store;
      if (!sameField) query = '';
      const scroll = box.querySelector('.legend-list')?.scrollTop ?? 0;
      const focus = focusKey();
      store = s;
      field = f;
      kind = k;
      background = bg;
      ramp = rampName;
      if (f && k === 'categorical') {
        const totals = legendEntries(s, f, null, bg);
        const shown = counted ? legendEntries(s, f, counted, bg) : totals;
        entries = totals
          .map((e, code) => ({ ...shown[code], code, total: e.count }))
          .filter(e => e.total > 0)
          .sort((a, b) => b.total - a.total || a.code - b.code);
      } else {
        entries = [];
      }
      render();
      if (sameField) {
        const list = box.querySelector('.legend-list');
        if (list) list.scrollTop = scroll;
      }
      if (focus) box.querySelector<HTMLElement>(focus)?.focus();
    }
  };
}
