import type { SelectionContext } from '../context/build';
import type { ChatAdapter, Turn } from './adapter';

const MAX_LEVELS_SHOWN = 12;

function topLevels(counts: Record<string, number>): { label: string; count: number }[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }));
}

/**
 * The prompt block describing a selection.
 *
 * Shared by the mock adapter and mirrored exactly by the server proxy, so
 * both see the same description of the selection; if they diverged, testing
 * against the mock would stop telling you anything about the real path.
 */
export function renderContextAsText(ctx: SelectionContext | null): string {
  if (!ctx || ctx.n === 0) {
    return 'No cells are currently selected in the viewer.';
  }
  const lines: string[] = [
    `Selection from dataset "${ctx.datasetId}" (${ctx.view} view).`,
    `${ctx.n.toLocaleString('en-US')} cells selected out of ${ctx.totalN.toLocaleString('en-US')} total ` +
      `(${((ctx.n / ctx.totalN) * 100).toFixed(2)}%).`,
    `Region: x ${ctx.bbox[0].toFixed(2)} to ${ctx.bbox[2].toFixed(2)}, ` +
      `y ${ctx.bbox[1].toFixed(2)} to ${ctx.bbox[3].toFixed(2)}; ` +
      `centroid (${ctx.centroid[0].toFixed(2)}, ${ctx.centroid[1].toFixed(2)}).`,
    `Currently coloured by: ${ctx.colorBy}.`,
    ''
  ];

  for (const [field, counts] of Object.entries(ctx.breakdown)) {
    const levels = topLevels(counts);
    if (levels.length === 0) continue;
    lines.push(`${field} composition:`);
    for (const { label, count } of levels.slice(0, MAX_LEVELS_SHOWN)) {
      lines.push(
        `  ${label}: ${count.toLocaleString('en-US')} (${((count / ctx.n) * 100).toFixed(1)}%)`
      );
    }
    if (levels.length > MAX_LEVELS_SHOWN) {
      lines.push(`  ... and ${levels.length - MAX_LEVELS_SHOWN} more levels`);
    }
    lines.push('');
  }

  for (const [field, s] of Object.entries(ctx.numericStats)) {
    lines.push(
      `${field}: min ${s.min.toFixed(3)}, q1 ${s.q[0].toFixed(3)}, median ${s.q[1].toFixed(3)}, ` +
        `q3 ${s.q[2].toFixed(3)}, max ${s.max.toFixed(3)}, mean ${s.mean.toFixed(3)}`
    );
  }
  lines.push('', `Example cell ids: ${ctx.sampleIds.slice(0, 8).join(', ')}`);
  return lines.join('\n');
}

/**
 * Answers from the context alone, with no network and no key.
 *
 * This exists so the entire selection-to-answer path can be exercised in
 * tests and offline development. It is a lookup over the summary, not a
 * model, and it says so.
 */
export class MockAdapter implements ChatAdapter {
  readonly name = 'mock';

  async *send(
    ctx: SelectionContext | null,
    question: string,
    _history: Turn[],
    _signal?: AbortSignal
  ): AsyncIterable<string> {
    const answer = this.answer(ctx, question);
    // Stream in word groups so the panel's streaming path is exercised.
    const words = answer.split(' ');
    for (let i = 0; i < words.length; i += 6) {
      yield words.slice(i, i + 6).join(' ') + (i + 6 < words.length ? ' ' : '');
      await new Promise(r => setTimeout(r, 4));
    }
  }

  private answer(ctx: SelectionContext | null, question: string): string {
    if (!ctx || ctx.n === 0) {
      return 'No cells are selected. Draw a box or lasso on the plot and ask again.';
    }
    const q = question.toLowerCase();
    const top = (field: string): { label: string; count: number } | undefined =>
      topLevels(ctx.breakdown[field] ?? {})[0];

    if (/how many|count|number of/.test(q)) {
      return (
        `${ctx.n.toLocaleString('en-US')} cells are selected, which is ` +
        `${((ctx.n / ctx.totalN) * 100).toFixed(2)}% of the ` +
        `${ctx.totalN.toLocaleString('en-US')} in this dataset.`
      );
    }
    if (/tissue|organ/.test(q)) {
      const t = top('tissue');
      return t
        ? `The selection is dominated by ${t.label} ` +
            `(${t.count.toLocaleString('en-US')} cells, ${((t.count / ctx.n) * 100).toFixed(1)}%).`
        : 'This dataset has no tissue annotation.';
    }
    if (/cell type|celltype|composition|what.*cells/.test(q)) {
      const levels = topLevels(ctx.breakdown.cell_type ?? {}).slice(0, 4);
      return levels.length
        ? 'Top cell types in the selection: ' +
            levels.map(l => `${l.label} (${l.count.toLocaleString('en-US')})`).join(', ') +
            '.'
        : 'This dataset has no cell type annotation.';
    }
    if (/pseudotime|trajectory|time|stage|develop/.test(q)) {
      const s = ctx.numericStats.pseudotime;
      return s
        ? `Pseudotime across the selection runs ${s.min.toFixed(3)} to ${s.max.toFixed(3)} ` +
            `with a median of ${s.q[1].toFixed(3)}.`
        : 'This dataset has no pseudotime values.';
    }
    // Fall through to the full summary rather than pretending to reason.
    return (
      '[mock adapter — no model is connected] Here is what the viewer knows about ' +
      `your selection:\n\n${renderContextAsText(ctx)}`
    );
  }
}
