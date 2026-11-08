import { describe, expect, it } from 'vitest';
import { allocateStore } from '@core/data/schema';
import type { Manifest } from '@core/data/manifest';

const manifest: Manifest = {
  datasetId: 'unit',
  n: 1000,
  chunkSize: 400,
  chunks: 3,
  bounds: [-1, -1, 1, 1],
  categorical: { cell_type: { levels: ['A', 'B'] }, tissue: { levels: ['lung'] } },
  numeric: { pseudotime: { min: 0, max: 1 } },
  hasGraph: false
};

describe('CellStore', () => {
  it('allocates typed arrays of exactly the right length', () => {
    const s = allocateStore(manifest);
    expect(s.n).toBe(1000);
    expect(s.xy.length).toBe(2000);
    expect(s.xy).toBeInstanceOf(Float32Array);
    expect(s.codes.get('cell_type')!.length).toBe(1000);
    expect(s.codes.get('cell_type')).toBeInstanceOf(Uint16Array);
    expect(s.numeric.get('pseudotime')!.length).toBe(1000);
    expect(s.color.length).toBe(4000);
  });

  it('carries the dataset id through for the chat context', () => {
    expect(allocateStore(manifest).datasetId).toBe('unit');
  });

  it('reports chunk ranges including a short final chunk', () => {
    const s = allocateStore(manifest);
    expect(s.chunkRange(0)).toEqual({ start: 0, count: 400 });
    expect(s.chunkRange(2)).toEqual({ start: 800, count: 200 });
  });

  it('starts with nothing loaded', () => {
    expect(allocateStore(manifest).loadedCount).toBe(0);
  });

  it('materialises only the sampled ids, never all n', () => {
    const s = allocateStore(manifest);
    const idx = new Uint32Array([5, 7, 900]);
    expect(s.sampleIds(idx, 100)).toEqual(['cell_5', 'cell_7', 'cell_900']);
    const all = Uint32Array.from({ length: 1000 }, (_, i) => i);
    expect(s.sampleIds(all, 10)).toHaveLength(10);
  });

  it('lists its categorical and numeric fields', () => {
    const s = allocateStore(manifest);
    expect(s.categoricalFields()).toEqual(['cell_type', 'tissue']);
    expect(s.numericFields()).toEqual(['pseudotime']);
  });
});
