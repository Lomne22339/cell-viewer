import type { SelectionContext } from '@core/context/build';
import { esc } from './escape';

export interface SummaryHandle {
  update: (ctx: SelectionContext | null, queryMs: number) => void;
}

export function createSelectionSummary(root: HTMLElement): SummaryHandle {
  const box = document.createElement('div');
  box.className = 'summary';
  root.appendChild(box);

  return {
    update(ctx, queryMs) {
      if (!ctx) {
        box.innerHTML = `<div class="summary-empty">No cells selected</div>`;
        return;
      }
      const top = (field: string): string =>
        Object.entries(ctx.breakdown[field] ?? {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(
            ([k, v]) => `<div class="sum-row"><span>${esc(k)}</span><b>${v.toLocaleString()}</b></div>`
          )
          .join('');
      const blocks = Object.keys(ctx.breakdown)
        .slice(0, 2)
        .map(f => `<div class="sum-block"><h4>${esc(f)}</h4>${top(f)}</div>`)
        .join('');
      const pct = ((ctx.n / ctx.totalN) * 100).toFixed(1);
      box.innerHTML =
        `<div class="summary-head">${ctx.n.toLocaleString()} cells selected` +
        `<span class="muted"> (${pct}% of ${ctx.totalN.toLocaleString()}, ` +
        `${queryMs.toFixed(1)} ms)</span></div>${blocks}`;
    }
  };
}
