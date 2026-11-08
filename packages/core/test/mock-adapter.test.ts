import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockAdapter, renderContextAsText } from '@core/chat/mock';
import type { SelectionContext } from '@core/context/build';

const ctx: SelectionContext = {
  datasetId: 'sim1m', view: 'embedding', n: 12843, totalN: 1_000_000,
  bbox: [-4, -2, 6, 9], centroid: [1, 3],
  breakdown: {
    cell_type: { 'T cell': 8000, Monocyte: 4843 },
    tissue: { lung: 12000, liver: 843 }
  },
  omittedLevels: {},
  numericStats: { pseudotime: { min: 0.1, max: 0.9, mean: 0.44, q: [0.2, 0.4, 0.7] } },
  sampleIds: ['cell_1', 'cell_2'],
  colorBy: 'cell_type',
  visibleN: 1_000_000,
  hidden: {}
};

async function collect(it: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of it) out += chunk;
  return out;
}

describe('renderContextAsText', () => {
  it('states the count and the dominant labels', () => {
    const text = renderContextAsText(ctx);
    expect(text).toContain('12,843');
    expect(text).toContain('T cell');
    expect(text).toContain('lung');
    expect(text).toContain('pseudotime');
  });

  it('states the legend filter and the share of visible cells when one is active', () => {
    const text = renderContextAsText({
      ...ctx,
      visibleN: 200_000,
      hidden: { cell_type: ['B cell', 'NK cell'] }
    });
    expect(text).toContain('12,843 cells selected out of 200,000 visible (1,000,000 total; 6.42% of visible)');
    expect(text).toContain('Legend filter hides cell_type: B cell, NK cell.');
  });

  it('says so plainly when nothing is selected', () => {
    expect(renderContextAsText(null).toLowerCase()).toContain('no cells');
  });

  it('truncates a long level list rather than emitting hundreds of lines', () => {
    const many: SelectionContext = {
      ...ctx,
      breakdown: {
        donor: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`donor_${i}`, 10]))
      }
    };
    const text = renderContextAsText(many);
    expect(text.split('\n').length).toBeLessThan(60);
    expect(text).toMatch(/more/i);
  });

  it('counts levels the context already left out in the "more levels" line', () => {
    const donors = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`donor_${i}`, 100 - i]));
    const text = renderContextAsText({ ...ctx, breakdown: { donor: donors }, omittedLevels: { donor: 4950 } });
    // 38 shown-but-not-printed plus 4,950 never sent.
    expect(text).toContain('  ... and 4988 more levels');
    // Omitted levels are reported even when every sent level is printed.
    const few = renderContextAsText({ ...ctx, breakdown: { donor: { a: 3, b: 2 } }, omittedLevels: { donor: 7 } });
    expect(few).toContain('  ... and 7 more levels');
  });

  it('accepts a context from before omittedLevels existed', () => {
    const { omittedLevels: _, ...old } = ctx;
    expect(renderContextAsText(old as SelectionContext)).toContain('T cell');
  });

  it('prints n/a for a missing or non-finite statistic instead of throwing', () => {
    const odd = {
      ...ctx,
      numericStats: {
        a: { min: null, max: NaN, mean: 0.5, q: [null, 0.1, Infinity] },
        b: { min: 1, max: 2, mean: 1.5 },
        c: null
      }
    } as unknown as SelectionContext;
    const text = renderContextAsText(odd);
    expect(text).toContain('a: min n/a, q1 n/a, median 0.100, q3 n/a, max n/a, mean 0.500');
    expect(text).toContain('b: min 1.000, q1 n/a, median n/a, q3 n/a, max 2.000, mean 1.500');
    expect(text).toContain('c: min n/a, q1 n/a, median n/a, q3 n/a, max n/a, mean n/a');
  });
});

/**
 * The same cases are asserted against the Python renderer in
 * server/tests/test_chat.py. Expected text was produced by this renderer;
 * the Python side must match it byte for byte.
 */
describe('renderContextAsText golden cases (shared with the server)', () => {
  const cases = JSON.parse(
    readFileSync(resolve(__dirname, 'fixtures/render-context.json'), 'utf8')
  ) as { name: string; context: SelectionContext | null; expected: string }[];

  it('has the cases the two renderers have disagreed on', () => {
    const names = cases.map(c => c.name);
    for (const required of ['ties', 'share-tie', 'filtered', 'filtered-to-zero', 'long-tail', 'null-stats', 'no-selection']) {
      expect(names).toContain(required);
    }
  });

  for (const c of cases) {
    it(c.name, () => {
      expect(renderContextAsText(c.context)).toBe(c.expected);
    });
  }
});

describe('MockAdapter', () => {
  it('answers a count question from the context alone', async () => {
    expect(await collect(new MockAdapter().send(ctx, 'how many cells are selected?', [])))
      .toContain('12,843');
  });

  it('answers a composition question with the top level', async () => {
    expect(await collect(new MockAdapter().send(ctx, 'what cell types are these?', [])))
      .toContain('T cell');
  });

  it('answers a tissue question', async () => {
    expect(await collect(new MockAdapter().send(ctx, 'which tissue?', []))).toContain('lung');
  });

  it('answers a pseudotime question', async () => {
    expect(await collect(new MockAdapter().send(ctx, 'where in pseudotime?', [])))
      .toContain('0.400');
  });

  it('refuses gracefully with no selection', async () => {
    const out = await collect(new MockAdapter().send(null, 'what is here?', []));
    expect(out.toLowerCase()).toContain('no cells');
  });

  it('streams in more than one chunk', async () => {
    const chunks: string[] = [];
    for await (const c of new MockAdapter().send(ctx, 'summarise everything you know', [])) {
      chunks.push(c);
    }
    expect(chunks.length).toBeGreaterThan(1);
  });
});
