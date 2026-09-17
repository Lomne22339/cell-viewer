import { describe, expect, it } from 'vitest';
import { allocateStore } from '@core/data/schema';
import type { Manifest } from '@core/data/manifest';
import { SelectionStore } from '@core/select/store';
import { buildSelectionContext } from '@core/context/build';

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
