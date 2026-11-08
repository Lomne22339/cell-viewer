import { describe, expect, it, vi } from 'vitest';
import { allocateStore } from '@core/data/schema';
import type { Manifest } from '@core/data/manifest';
import {
  CategoryFilter,
  computeVisibility,
  countVisible,
  filterIndices,
  hiddenLabels
} from '@core/filter/categories';

const manifest: Manifest = {
  datasetId: 'unit', n: 8, chunkSize: 8, chunks: 1, bounds: [0, 0, 1, 1],
  categorical: {
    cell_type: { levels: ['T', 'B', 'NK'] },
    tissue: { levels: ['lung', 'liver'] }
  },
  numeric: {},
  hasGraph: false
};

function store() {
  const s = allocateStore(manifest);
  s.codes.get('cell_type')!.set([0, 1, 2, 0, 1, 2, 0, 0]);
  s.codes.get('tissue')!.set([0, 0, 0, 1, 1, 1, 0, 1]);
  s.loadedCount = 8;
  return s;
}

describe('CategoryFilter (Plotly legend semantics)', () => {
  it('starts with nothing hidden and no active field', () => {
    const f = new CategoryFilter(store().levels);
    expect(f.isActive()).toBe(false);
    expect(computeVisibility(store(), f)).toBeNull();
  });

  it('click toggles a level off and back on', () => {
    const f = new CategoryFilter(store().levels);
    f.toggle('cell_type', 1);
    expect(f.isHidden('cell_type', 1)).toBe(true);
    expect(f.activeFields()).toEqual(['cell_type']);
    f.toggle('cell_type', 1);
    expect(f.isHidden('cell_type', 1)).toBe(false);
    expect(f.isActive()).toBe(false);
  });

  it('double-click isolates, and isolating the only visible level shows all again', () => {
    const f = new CategoryFilter(store().levels);
    f.isolate('cell_type', 2);
    expect(f.hiddenCodes('cell_type')).toEqual([0, 1]);
    f.isolate('cell_type', 2);
    expect(f.hiddenCodes('cell_type')).toEqual([]);
  });

  it('isolating a hidden level shows just that level', () => {
    const f = new CategoryFilter(store().levels);
    f.toggle('cell_type', 0);
    f.isolate('cell_type', 0);
    expect(f.hiddenCodes('cell_type')).toEqual([1, 2]);
  });

  it('isolating a different level when another is isolated switches to it', () => {
    const f = new CategoryFilter(store().levels);
    f.isolate('cell_type', 0);
    f.isolate('cell_type', 1);
    expect(f.hiddenCodes('cell_type')).toEqual([0, 2]);
  });

  it('show all, hide all and setHidden', () => {
    const f = new CategoryFilter(store().levels);
    f.hideAll('cell_type');
    expect(f.hiddenCodes('cell_type')).toEqual([0, 1, 2]);
    f.setHidden('cell_type', [1]);
    expect(f.hiddenCodes('cell_type')).toEqual([1]);
    f.toggle('tissue', 0);
    f.showAll('cell_type');
    expect(f.activeFields()).toEqual(['tissue']);
    f.showAll();
    expect(f.isActive()).toBe(false);
  });

  it('notifies once per change and bumps its version', () => {
    const f = new CategoryFilter(store().levels);
    const fn = vi.fn();
    const off = f.subscribe(fn);
    f.toggle('cell_type', 0);
    f.isolate('cell_type', 1);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(f.version).toBe(2);
    off();
    f.showAll();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rejects an unknown field by name', () => {
    expect(() => new CategoryFilter(store().levels).toggle('nope', 0)).toThrow(/unknown categorical field/);
  });
});

describe('visibility', () => {
  it('ANDs filters across fields', () => {
    const s = store();
    const f = new CategoryFilter(s.levels);
    f.isolate('cell_type', 0); // T only: cells 0, 3, 6, 7
    f.toggle('tissue', 1); // hide liver: cells 3, 4, 5, 7
    expect(Array.from(computeVisibility(s, f)!)).toEqual([1, 0, 0, 0, 0, 0, 1, 0]);
  });

  it('can ignore one field, so the legend counts a level as if it were shown', () => {
    const s = store();
    const f = new CategoryFilter(s.levels);
    f.isolate('cell_type', 0);
    f.toggle('tissue', 1);
    // Excluding cell_type leaves only the tissue filter (hide liver).
    expect(Array.from(computeVisibility(s, f, undefined, 'cell_type')!)).toEqual([1, 1, 1, 0, 0, 0, 1, 0]);
    // Excluding the only active field means no filter at all.
    f.showAll('tissue');
    expect(computeVisibility(s, f, undefined, 'cell_type')).toBeNull();
  });

  it('names the hidden levels per field', () => {
    const s = store();
    const f = new CategoryFilter(s.levels);
    f.toggle('cell_type', 1);
    f.toggle('tissue', 0);
    expect(hiddenLabels(f, s.levels)).toEqual({ cell_type: ['B'], tissue: ['lung'] });
  });

  it('marks the unloaded tail invisible and reuses a buffer', () => {
    const s = store();
    s.loadedCount = 4;
    const f = new CategoryFilter(s.levels);
    f.toggle('cell_type', 1);
    const buf = new Uint8Array(8).fill(7);
    const vis = computeVisibility(s, f, buf)!;
    expect(vis).toBe(buf);
    expect(Array.from(vis)).toEqual([1, 0, 1, 1, 0, 0, 0, 0]);
  });

  it('filters selection indices and counts visible cells', () => {
    const vis = Uint8Array.from([1, 0, 1, 1, 0]);
    expect(Array.from(filterIndices(Uint32Array.from([0, 1, 3, 4]), vis))).toEqual([0, 3]);
    const all = Uint32Array.from([0, 2]);
    expect(filterIndices(all, vis)).toBe(all);
    expect(filterIndices(all, null)).toBe(all);
    expect(countVisible(vis, 5)).toBe(3);
    expect(countVisible(null, 5)).toBe(5);
  });
});
