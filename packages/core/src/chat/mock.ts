import type { SelectionContext } from '../context/build';
import type { ChatAdapter, Turn } from './adapter';

const MAX_LEVELS_SHOWN = 12;

/** Levels by count, largest first; equal counts keep their order in the context. */
function topLevels(counts: Record<string, number>): { label: string; count: number }[] {
  return Object.entries(counts)
    .filter(([, count]) => typeof count === 'number' && Number.isFinite(count))
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }));
}

/**
 * `toFixed`, or `n/a` for a value that is missing or not finite. A NaN
 * statistic travels as null in JSON, and the prompt should say "not
 * available" rather than "NaN" or fail to render at all.
 */
function fixed(value: unknown, digits: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

/**
 * The prompt block describing a selection.
 *
 * Shared by the mock adapter and mirrored byte for byte by the server proxy
 * (`render_context_as_text` in server/chat.py), so both see the same
 * description of the selection; if they diverged, testing against the mock
 * would stop telling you anything about the real path. The golden cases in
 * test/fixtures/render-context.json are asserted against both.
 */
export function renderContextAsText(ctx: SelectionContext | null): string {
  if (!ctx || !(ctx.n > 0)) {
    return 'No cells are currently selected in the viewer.';
  }
  const visibleN = ctx.visibleN ?? ctx.totalN;
  const filtered = visibleN < ctx.totalN;
  const bbox = ctx.bbox ?? [];
  const centroid = ctx.centroid ?? [];
  const lines: string[] = [
    `Selection from dataset "${ctx.datasetId ?? '?'}" (${ctx.view ?? 'embedding'} view).`,
    filtered
      ? `${ctx.n.toLocaleString('en-US')} cells selected out of ${visibleN.toLocaleString('en-US')} visible ` +
        `(${ctx.totalN.toLocaleString('en-US')} total; ${fixed((ctx.n / Math.max(1, visibleN)) * 100, 2)}% of visible).`
      : `${ctx.n.toLocaleString('en-US')} cells selected out of ${ctx.totalN.toLocaleString('en-US')} total ` +
        `(${fixed((ctx.n / ctx.totalN) * 100, 2)}%).`,
    `Region: x ${fixed(bbox[0], 2)} to ${fixed(bbox[2], 2)}, ` +
      `y ${fixed(bbox[1], 2)} to ${fixed(bbox[3], 2)}; ` +
      `centroid (${fixed(centroid[0], 2)}, ${fixed(centroid[1], 2)}).`,
    `Currently coloured by: ${ctx.colorBy ?? '?'}.`
  ];
  for (const [field, labels] of Object.entries(ctx.hidden ?? {})) {
    if (!labels.length) continue;
    const shown = labels.slice(0, MAX_LEVELS_SHOWN).join(', ');
    const more = labels.length > MAX_LEVELS_SHOWN ? ` and ${labels.length - MAX_LEVELS_SHOWN} more` : '';
    lines.push(`Legend filter hides ${field}: ${shown}${more}.`);
  }
  lines.push('');

  for (const [field, counts] of Object.entries(ctx.breakdown ?? {})) {
    const levels = topLevels(counts ?? {});
    if (levels.length === 0) continue;
    lines.push(`${field} composition:`);
    for (const { label, count } of levels.slice(0, MAX_LEVELS_SHOWN)) {
      lines.push(`  ${label}: ${count.toLocaleString('en-US')} (${fixed((count / ctx.n) * 100, 1)}%)`);
    }
    // Levels sent but not printed, plus levels the context builder never sent.
    const omitted = ctx.omittedLevels?.[field];
    const more =
      Math.max(0, levels.length - MAX_LEVELS_SHOWN) +
      (typeof omitted === 'number' && Number.isFinite(omitted) ? omitted : 0);
    if (more > 0) lines.push(`  ... and ${more} more levels`);
    lines.push('');
  }

  for (const [field, stats] of Object.entries(ctx.numericStats ?? {})) {
    const s: Partial<SelectionContext['numericStats'][string]> = stats ?? {};
    const q = s.q ?? [];
    lines.push(
      `${field}: min ${fixed(s.min, 3)}, q1 ${fixed(q[0], 3)}, median ${fixed(q[1], 3)}, ` +
        `q3 ${fixed(q[2], 3)}, max ${fixed(s.max, 3)}, mean ${fixed(s.mean, 3)}`
    );
  }
  lines.push('', `Example cell ids: ${(ctx.sampleIds ?? []).slice(0, 8).join(', ')}`);
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
        ? `Pseudotime across the selection runs ${fixed(s.min, 3)} to ${fixed(s.max, 3)} ` +
            `with a median of ${fixed(s.q?.[1], 3)}.`
        : 'This dataset has no pseudotime values.';
    }
    // Fall through to the full summary rather than pretending to reason.
    return (
      '[mock adapter — no model is connected] Here is what the viewer knows about ' +
      `your selection:\n\n${renderContextAsText(ctx)}`
    );
  }
}
