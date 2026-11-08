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
      // Under a legend filter the meaningful denominator is what is visible.
      const visible = ctx.visibleN ?? ctx.totalN;
      const filtered = visible < ctx.totalN;
      const pct = ((ctx.n / Math.max(1, visible)) * 100).toFixed(1);
      const of = filtered
        ? `${pct}% of ${visible.toLocaleString()} visible`
        : `${pct}% of ${ctx.totalN.toLocaleString()}`;
      box.innerHTML =
        `<div class="summary-head">${ctx.n.toLocaleString()} cells selected` +
        `<span class="muted"> (${of}, ${queryMs.toFixed(1)} ms)</span></div>${blocks}`;
    }
  };
}
