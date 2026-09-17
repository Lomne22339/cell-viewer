import { describe, expect, it } from 'vitest';
import { allocateStore } from '@core/data/schema';
import { defaultColorField } from '@core/color/defaults';
import type { Manifest } from '@core/data/manifest';

const base: Manifest = {
  datasetId: 'unit', n: 4, chunkSize: 4, chunks: 1, bounds: [0, 0, 1, 1],
  categorical: {}, numeric: {}, hasGraph: false
};

describe('defaultColorField', () => {
  it('prefers the first categorical field', () => {
    const s = allocateStore({
      ...base,
      categorical: { cell_type: { levels: ['A'] } },
      numeric: { pseudotime: { min: 0, max: 1 } }
    });
    expect(defaultColorField(s)).toEqual({ field: 'cell_type', kind: 'categorical' });
  });

  it('falls back to a numeric field when there are no categoricals', () => {
    // A Parquet file with only x, y and pseudotime produces exactly this, and
    // without a fallback every point is painted with alpha 0 — a blank canvas.
    const s = allocateStore({ ...base, numeric: { pseudotime: { min: 0, max: 1 } } });
    expect(defaultColorField(s)).toEqual({ field: 'pseudotime', kind: 'numeric' });
  });

  it('returns null when a dataset carries no annotations at all', () => {
    expect(defaultColorField(allocateStore(base))).toBeNull();
  });
});
