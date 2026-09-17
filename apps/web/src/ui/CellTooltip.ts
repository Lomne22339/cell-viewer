import type { CellStore } from '@core/data/schema';
import { esc } from './escape';

export interface TooltipHandle {
  show: (index: number | null, x: number, y: number) => void;
  destroy: () => void;
}

/**
 * Per-cell metadata on hover.
 *
 * Every dot is one cell, and the annotations that make the plot meaningful —
 * cell type, tissue, donor, stage, pseudotime — only exist per cell. Reading
 * them straight off the columnar arrays by index costs nothing, so there is no
 * reason to make the user select a region just to see what one dot is.
 */
export function createCellTooltip(host: HTMLElement, store: CellStore): TooltipHandle {
  const el = document.createElement('div');
  el.className = 'tooltip';
  el.hidden = true;
  host.appendChild(el);

  let lastIndex: number | null = null;

  return {
    show(index, x, y) {
      if (index === null) {
        el.hidden = true;
        lastIndex = null;
        return;
      }
      if (index !== lastIndex) {
        lastIndex = index;
        const rows: string[] = [`<b>cell_${index}</b>`];
        for (const [field, codes] of store.codes) {
          const labels = store.levels.get(field)!;
          const label = labels[codes[index] % labels.length] ?? '—';
          rows.push(`<span>${esc(field)}</span><i>${esc(label)}</i>`);
        }
        for (const [field, values] of store.numeric) {
          rows.push(`<span>${esc(field)}</span><i>${values[index].toFixed(3)}</i>`);
        }
        rows.push(
          `<span>position</span><i>${store.xy[index * 2].toFixed(2)}, ` +
            `${store.xy[index * 2 + 1].toFixed(2)}</i>`
        );
        el.innerHTML = rows.join('');
      }
      el.hidden = false;
      // Flip to the other side near the right/bottom edge so the tooltip never
      // pushes itself off the canvas.
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = x + 14 + w > host.clientWidth ? x - w - 14 : x + 14;
      const top = y + 14 + h > host.clientHeight ? y - h - 14 : y + 14;
      el.style.left = `${Math.max(0, left)}px`;
      el.style.top = `${Math.max(0, top)}px`;
    },
    destroy() {
      el.remove();
    }
  };
}
