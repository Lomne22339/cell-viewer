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
  numericStats: { pseudotime: { min: 0.1, max: 0.9, mean: 0.44, q: [0.2, 0.4, 0.7] } },
  sampleIds: ['cell_1', 'cell_2'],
  colorBy: 'cell_type'
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
