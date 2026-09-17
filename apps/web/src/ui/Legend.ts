import type { CellStore } from '@core/data/schema';
import { legendEntries } from '@core/color/recolor';
import { esc } from './escape';

const MAX_ROWS = 20;

export interface LegendHandle {
  update: (store: CellStore, field: string, kind: 'categorical' | 'numeric') => void;
}

export function createLegend(root: HTMLElement): LegendHandle {
  const box = document.createElement('div');
  box.className = 'legend';
  root.appendChild(box);

  return {
    update(store, field, kind) {
      if (!field) {
        box.innerHTML = '';
        return;
      }
      if (kind === 'numeric') {
        const [lo, hi] = store.numericRange.get(field) ?? [0, 1];
        box.innerHTML =
          `<div class="legend-title">${esc(field)}</div>` +
          `<div class="ramp"></div>` +
          `<div class="ramp-labels"><span>${lo.toFixed(2)}</span><span>${hi.toFixed(2)}</span></div>`;
        return;
      }
      // Long tails are common (hundreds of donors); show the top rows by count.
      const entries = legendEntries(store, field)
        .filter(e => e.count > 0)
        .sort((a, b) => b.count - a.count);
      const shown = entries.slice(0, MAX_ROWS);
      const hidden = entries.length - shown.length;
      box.innerHTML =
        `<div class="legend-title">${esc(field)}</div>` +
        shown
          .map(
            e =>
              `<div class="legend-row"><i style="background:rgb(${e.rgb.join(',')})"></i>` +
              `<span>${esc(e.label)}</span><b>${e.count.toLocaleString()}</b></div>`
          )
          .join('') +
        (hidden > 0 ? `<div class="legend-more">+${hidden} more</div>` : '');
    }
  };
}
