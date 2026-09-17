import { describe, expect, it } from 'vitest';
import { allocateStore } from '@core/data/schema';
import type { Manifest } from '@core/data/manifest';
import { paletteFor, rampSample, VIRIDIS } from '@core/color/palette';
import {
  applySelectionMask,
  legendEntries,
  recolorCategorical,
  recolorNumeric
} from '@core/color/recolor';

const manifest: Manifest = {
  datasetId: 'unit', n: 6, chunkSize: 6, chunks: 1, bounds: [0, 0, 1, 1],
  categorical: { cell_type: { levels: ['A', 'B', 'C'] } },
  numeric: { pseudotime: { min: 0, max: 1 } },
  hasGraph: false
};

function store() {
  const s = allocateStore(manifest);
  s.codes.get('cell_type')!.set([0, 1, 2, 0, 1, 2]);
  s.numeric.get('pseudotime')!.set([0, 0.2, 0.4, 0.6, 0.8, 1]);
  s.loadedCount = 6;
  return s;
}

describe('palette', () => {
  it('gives distinct colours to distinct levels', () => {
    const p = paletteFor(3);
    const seen = new Set([0, 1, 2].map(i => `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`));
    expect(seen.size).toBe(3);
  });

  it('wraps rather than throwing when levels exceed palette length', () => {
    expect(paletteFor(500).length).toBe(500 * 3);
  });

  it('samples a continuous ramp at both ends and the middle', () => {
    const out = new Uint8Array(12);
    rampSample(VIRIDIS, 0, out, 0);
    rampSample(VIRIDIS, 0.5, out, 4);
    rampSample(VIRIDIS, 1, out, 8);
    expect([out[0], out[1], out[2]]).not.toEqual([out[8], out[9], out[10]]);
    expect(out[9]).toBeGreaterThan(out[1]);
  });

  it('clamps out-of-range ramp positions instead of reading past the end', () => {
    const out = new Uint8Array(8);
    rampSample(VIRIDIS, -5, out, 0);
    rampSample(VIRIDIS, 99, out, 4);
    expect(out.slice(0, 3)).toEqual(VIRIDIS.slice(0, 3));
    expect(out.slice(4, 7)).toEqual(VIRIDIS.slice(VIRIDIS.length - 3));
  });

  it('treats NaN as the low end rather than producing undefined bytes', () => {
    const out = new Uint8Array(4);
    rampSample(VIRIDIS, NaN, out, 0);
    expect(out.slice(0, 3)).toEqual(VIRIDIS.slice(0, 3));
  });
});

describe('recolor', () => {
  it('assigns the same colour to cells of the same level', () => {
    const s = store();
    recolorCategorical(s, 'cell_type');
    expect(s.color.slice(0, 3)).toEqual(s.color.slice(12, 15));
    expect(s.color.slice(0, 3)).not.toEqual(s.color.slice(4, 7));
    expect(s.color[3]).toBe(255);
  });

  it('maps a numeric field monotonically along the ramp', () => {
    const s = store();
    recolorNumeric(s, 'pseudotime');
    const green = (i: number) => s.color[i * 4 + 1];
    expect(green(5)).toBeGreaterThan(green(0));
  });

  it('handles a constant numeric field without dividing by zero', () => {
    const s = store();
    s.numeric.get('pseudotime')!.fill(0.5);
    s.numericRange.set('pseudotime', [0.5, 0.5]);
    expect(() => recolorNumeric(s, 'pseudotime')).not.toThrow();
    expect(Number.isNaN(s.color[0])).toBe(false);
  });

  it('throws a named error for an unknown field', () => {
    expect(() => recolorCategorical(store(), 'nope')).toThrow(/unknown categorical field/);
    expect(() => recolorNumeric(store(), 'nope')).toThrow(/unknown numeric field/);
  });

  it('only colours loaded cells, leaving the tail transparent', () => {
    const s = store();
    s.loadedCount = 3;
    recolorCategorical(s, 'cell_type');
    expect(s.color[3]).toBe(255);
    expect(s.color[5 * 4 + 3]).toBe(0);
  });

  it('dims unselected cells and keeps selected ones opaque', () => {
    const s = store();
    recolorCategorical(s, 'cell_type');
    const hueBefore = s.color.slice(4, 7);
    applySelectionMask(s.color, new Uint8Array([1, 0, 0, 1, 0, 0]), 40, 255);
    expect(s.color[3]).toBe(255);
    expect(s.color[7]).toBe(40);
    expect(s.color.slice(4, 7)).toEqual(hueBefore);
  });

  it('restores full opacity when the mask is cleared', () => {
    const s = store();
    recolorCategorical(s, 'cell_type');
    applySelectionMask(s.color, new Uint8Array([1, 0, 0, 0, 0, 0]), 40, 255);
    applySelectionMask(s.color, null, 40, 255);
    for (let i = 0; i < 6; i++) expect(s.color[i * 4 + 3]).toBe(255);
  });

  it('dims unselected cells by darkening colour, keeping every point opaque', () => {
    const s = store();
    recolorCategorical(s, 'cell_type', 255, 0, {
      mask: new Uint8Array([1, 0, 0, 1, 0, 0]),
      factor: 0.25
    });
    // Cell 0 selected, cell 3 selected, cells 1/2/4/5 dimmed.
    expect(s.color[3]).toBe(255);
    expect(s.color[7]).toBe(255);
    const bright = s.color[4];
    const undimmed = paletteFor(3)[3];
    expect(bright).toBe(Math.trunc(undimmed * 0.25));
    expect(bright).toBeLessThan(undimmed);
  });

  it('does not compound dimming when the selection changes repeatedly', () => {
    const s = store();
    const dim = { mask: new Uint8Array([1, 0, 0, 0, 0, 0]), factor: 0.25 };
    recolorCategorical(s, 'cell_type', 255, 0, dim);
    const once = s.color[4];
    recolorCategorical(s, 'cell_type', 255, 0, dim);
    recolorCategorical(s, 'cell_type', 255, 0, dim);
    expect(s.color[4]).toBe(once);
  });

  it('restores full brightness when the selection is cleared', () => {
    const s = store();
    recolorCategorical(s, 'cell_type', 255, 0, {
      mask: new Uint8Array([1, 0, 0, 0, 0, 0]),
      factor: 0.25
    });
    recolorCategorical(s, 'cell_type', 255, 0, { mask: null, factor: 0.25 });
    expect(s.color[4]).toBe(paletteFor(3)[3]);
  });

  it('dims a numeric colouring the same way', () => {
    const s = store();
    recolorNumeric(s, 'pseudotime', undefined, 255, 0, { mask: null, factor: 0.25 });
    const full = s.color[4 + 1];
    recolorNumeric(s, 'pseudotime', undefined, 255, 0, {
      mask: new Uint8Array([1, 0, 0, 0, 0, 0]),
      factor: 0.25
    });
    expect(s.color[5]).toBeLessThan(full);
    expect(s.color[7]).toBe(255);
  });

  it('builds legend entries with counts that sum to the loaded count', () => {
    const entries = legendEntries(store(), 'cell_type');
    expect(entries.map(e => e.label)).toEqual(['A', 'B', 'C']);
    expect(entries.reduce((a, e) => a + e.count, 0)).toBe(6);
  });
});
