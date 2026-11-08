import { describe, expect, it } from 'vitest';
import { allocateStore } from '@core/data/schema';
import type { Manifest } from '@core/data/manifest';
import { SelectionStore, type Selection } from '@core/select/store';
import { buildSelectionContext, MAX_CONTEXT_LEVELS, quartiles } from '@core/context/build';

const manifest: Manifest = {
  datasetId: 'unit', n: 8, chunkSize: 8, chunks: 1, bounds: [0, 0, 10, 10],
  categorical: { cell_type: { levels: ['A', 'B'] }, tissue: { levels: ['lung', 'liver'] } },
  numeric: { pseudotime: { min: 0, max: 1 } },
  hasGraph: false
};

function fixture() {
  const s = allocateStore(manifest);
  s.xy.set([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]);
  s.codes.get('cell_type')!.set([0, 0, 0, 1, 1, 1, 1, 0]);
  s.codes.get('tissue')!.set([0, 1, 0, 1, 0, 1, 0, 1]);
  s.numeric.get('pseudotime')!.set([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
  s.loadedCount = 8;
  return s;
}

const meta = { datasetId: 'unit', view: 'embedding' as const, colorBy: 'cell_type' };

describe('buildSelectionContext', () => {
  it('counts each categorical level within the selection only', () => {
    const s = fixture();
    const sel = new SelectionStore(8, s.xy);
    sel.set(Uint32Array.from([0, 1, 2, 3]), 'rect');
    const ctx = buildSelectionContext(s, sel.current!, meta);
    expect(ctx.n).toBe(4);
    expect(ctx.totalN).toBe(8);
    expect(ctx.breakdown.cell_type).toEqual({ A: 3, B: 1 });
    expect(ctx.breakdown.tissue).toEqual({ lung: 2, liver: 2 });
  });

  it('breakdown counts sum to n for every field', () => {
    const s = fixture();
    const sel = new SelectionStore(8, s.xy);
    sel.set(Uint32Array.from([1, 3, 5, 7]), 'poly');
    const ctx = buildSelectionContext(s, sel.current!, meta);
    for (const field of Object.keys(ctx.breakdown)) {
      const total = Object.values(ctx.breakdown[field]).reduce((a, b) => a + b, 0);
      expect(total).toBe(ctx.n);
    }
  });

  it('omits levels with zero cells rather than listing every level', () => {
    const s = fixture();
    const sel = new SelectionStore(8, s.xy);
    sel.set(Uint32Array.from([0, 2]), 'rect');
    const ctx = buildSelectionContext(s, sel.current!, meta);
    expect(ctx.breakdown.cell_type).toEqual({ A: 2 });
    expect(ctx.breakdown.tissue).toEqual({ lung: 2 });
  });

  it('computes centroid, bbox and numeric stats', () => {
    const s = fixture();
    const sel = new SelectionStore(8, s.xy);
    sel.set(Uint32Array.from([0, 1, 2, 3]), 'rect');
    const ctx = buildSelectionContext(s, sel.current!, meta);
    expect(ctx.bbox).toEqual([0, 0, 3, 3]);
    expect(ctx.centroid[0]).toBeCloseTo(1.5);
    const pt = ctx.numericStats.pseudotime;
    expect(pt.min).toBeCloseTo(0);
    expect(pt.max).toBeCloseTo(0.3);
    expect(pt.mean).toBeCloseTo(0.15);
    expect(pt.q[1]).toBeGreaterThanOrEqual(pt.min);
    expect(pt.q[1]).toBeLessThanOrEqual(pt.max);
  });

  it('carries the visible total and the hidden levels into the context', () => {
    const s = fixture();
    const sel = new SelectionStore(8, s.xy);
    sel.set(Uint32Array.from([0, 1]), 'rect');
    const plain = buildSelectionContext(s, sel.current!, meta);
    expect(plain.visibleN).toBe(8);
    expect(plain.hidden).toEqual({});
    const filtered = buildSelectionContext(s, sel.current!, { ...meta, visibleN: 5, hidden: { tissue: ['liver'] } });
    expect(filtered.visibleN).toBe(5);
    expect(filtered.hidden).toEqual({ tissue: ['liver'] });
  });

  it('caps sampleIds at 100 no matter how large the selection', () => {
    const big = allocateStore({ ...manifest, n: 500_000, chunkSize: 500_000, chunks: 1 });
    big.loadedCount = 500_000;
    const sel = new SelectionStore(500_000, big.xy);
    sel.set(Uint32Array.from({ length: 400_000 }, (_, i) => i), 'poly');
    const ctx = buildSelectionContext(big, sel.current!, meta);
    expect(ctx.n).toBe(400_000);
    expect(ctx.sampleIds).toHaveLength(100);
  });

  it('stays small when serialised, even for a huge selection', () => {
    const big = allocateStore({ ...manifest, n: 500_000, chunkSize: 500_000, chunks: 1 });
    big.loadedCount = 500_000;
    const sel = new SelectionStore(500_000, big.xy);
    sel.set(Uint32Array.from({ length: 400_000 }, (_, i) => i), 'poly');
    const ctx = buildSelectionContext(big, sel.current!, meta);
    // The whole point of summarising: token cost must not scale with n.
    expect(JSON.stringify(ctx).length).toBeLessThan(8000);
  });

  it('records no omitted levels when every field fits', () => {
    const s = fixture();
    const sel = new SelectionStore(8, s.xy);
    sel.set(Uint32Array.from([0, 1, 2, 3]), 'rect');
    expect(buildSelectionContext(s, sel.current!, meta).omittedLevels).toEqual({});
  });

  it(`keeps the ${MAX_CONTEXT_LEVELS} largest levels of a long-tailed field and counts the rest`, () => {
    expect(MAX_CONTEXT_LEVELS).toBe(50);
    const levels = Array.from({ length: 5000 }, (_, i) => `donor_${String(i).padStart(4, '0')}`);
    const n = 10_100;
    const big = allocateStore({
      ...manifest, n, chunkSize: n, chunks: 1,
      categorical: { ...manifest.categorical, donor: { levels } }
    });
    const donor = big.codes.get('donor')!;
    // Two cells per donor, then two more for each of the last fifty, so the
    // largest levels are the ones a code-order truncation would drop.
    for (let i = 0; i < 10_000; i++) donor[i] = i % 5000;
    for (let i = 10_000; i < n; i++) donor[i] = 4950 + ((i - 10_000) % 50);
    big.loadedCount = n;
    const sel = new SelectionStore(n, big.xy);
    sel.set(Uint32Array.from({ length: n }, (_, i) => i), 'poly');
    const ctx = buildSelectionContext(big, sel.current!, meta);

    const kept = Object.keys(ctx.breakdown.donor);
    expect(kept).toHaveLength(50);
    expect(kept.sort()).toEqual(levels.slice(4950));
    expect(Object.values(ctx.breakdown.donor).every(c => c === 4)).toBe(true);
    expect(ctx.omittedLevels).toEqual({ donor: 4950 });
    // The server rejects contexts over 32,000 bytes; a long tail must not get near it.
    expect(JSON.stringify(ctx).length).toBeLessThan(32_000);
  });

  it('counts only non-empty levels as omitted, and breaks count ties by level order', () => {
    const levels = Array.from({ length: 300 }, (_, i) => `L${i}`);
    const n = 51;
    const s = allocateStore({ ...manifest, n, chunkSize: n, chunks: 1, categorical: { donor: { levels } } });
    // 51 distinct levels with one cell each; 249 levels are empty.
    const donor = s.codes.get('donor')!;
    for (let i = 0; i < n; i++) donor[i] = i * 5;
    s.loadedCount = n;
    const sel = new SelectionStore(n, s.xy);
    sel.set(Uint32Array.from({ length: n }, (_, i) => i), 'poly');
    const ctx = buildSelectionContext(s, sel.current!, meta);
    expect(ctx.omittedLevels).toEqual({ donor: 1 });
    expect(Object.keys(ctx.breakdown.donor)).not.toContain('L250');
    expect(Object.keys(ctx.breakdown.donor)).toContain('L245');

    sel.set(Uint32Array.from({ length: 50 }, (_, i) => i), 'poly');
    expect(buildSelectionContext(s, sel.current!, meta).omittedLevels).toEqual({});
  });

  it('summarises numeric fields over finite values only', () => {
    const m: Manifest = { ...manifest, numeric: { pseudotime: { min: 0, max: 1 }, score: { min: 0, max: 1 } } };
    const s = allocateStore(m);
    s.numeric.get('pseudotime')!.set([NaN, 0.2, Infinity, 0.8, -Infinity, 0.5, 0.5, 0.5]);
    s.numeric.get('score')!.set([NaN, NaN, Infinity, -Infinity, 1, 1, 1, 1]);
    s.loadedCount = 8;
    const sel = new SelectionStore(8, s.xy);
    sel.set(Uint32Array.from([0, 1, 2, 3]), 'rect');
    const ctx = buildSelectionContext(s, sel.current!, meta);
    const lo = Math.fround(0.2);
    const hi = Math.fround(0.8);
    expect(ctx.numericStats.pseudotime).toEqual({
      min: lo, max: hi, mean: (lo + hi) / 2, q: quartiles(Float64Array.of(lo, hi))
    });
    // No finite value at all: the field is left out rather than reported as NaN,
    // which JSON would turn into null.
    expect(ctx.numericStats).not.toHaveProperty('score');
    expect(JSON.stringify(ctx)).not.toContain('null');
  });

  it('summarises an empty selection without inventing statistics', () => {
    const s = fixture();
    const empty: Selection = { indices: new Uint32Array(0), mask: new Uint8Array(8), bbox: [0, 0, 0, 0], shape: 'rect' };
    const ctx = buildSelectionContext(s, empty, meta);
    expect(ctx.n).toBe(0);
    expect(ctx.numericStats).toEqual({});
    expect(ctx.breakdown).toEqual({ cell_type: {}, tissue: {} });
    expect(ctx.omittedLevels).toEqual({});
    expect(ctx.sampleIds).toEqual([]);
  });

  it('samples ids spread across the selection, not just the first few', () => {
    const s = fixture();
    const sel = new SelectionStore(8, s.xy);
    sel.set(Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7]), 'poly');
    const ctx = buildSelectionContext(s, sel.current!, meta, 4);
    expect(ctx.sampleIds).toHaveLength(4);
    expect(new Set(ctx.sampleIds).size).toBe(4);
    expect(ctx.sampleIds).toEqual(['cell_0', 'cell_2', 'cell_4', 'cell_6']);
  });
});

describe('quartiles', () => {
  // Expected values are numpy.quantile's output, bit for bit, so the viewer
  // and a notebook give the same numbers for the same cells.
  it('interpolates linearly between order statistics, as numpy does', () => {
    expect(quartiles(Float64Array.of(0.8, 0.2))).toEqual([0.35000000000000003, 0.5, 0.65]);
    expect(quartiles(Float64Array.of(4, 1, 3, 2))).toEqual([1.75, 2.5, 3.25]);
    expect(quartiles(Float64Array.of(5, 4, 3, 2, 1))).toEqual([2, 3, 4]);
  });

  it('returns the value itself for a single element, and NaN for none', () => {
    expect(quartiles(Float64Array.of(7))).toEqual([7, 7, 7]);
    expect(quartiles(new Float64Array(0))).toEqual([NaN, NaN, NaN]);
  });

  it('does not reorder its input', () => {
    const v = Float64Array.of(3, 1, 2);
    quartiles(v);
    expect(Array.from(v)).toEqual([3, 1, 2]);
  });
});
