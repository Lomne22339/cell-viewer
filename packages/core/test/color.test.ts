import { describe, expect, it } from 'vitest';
import { allocateStore } from '@core/data/schema';
import type { Manifest } from '@core/data/manifest';
import { MAGMA, paletteFor, rampFor, rampSample, RAMPS, VIRIDIS } from '@core/color/palette';
import {
  applySelectionMask,
  legendEntries,
  recolorCategorical,
  recolorConstant,
  recolorNumeric
} from '@core/color/recolor';
import { contrastRatio, THEMES, type Rgb } from '@core/theme/themes';

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

/** The palette formula as it stood before background adjustment existed. */
function legacyPalette(levelCount: number): number[] {
  const base = [
    31, 119, 180, 255, 127, 14, 44, 160, 44, 214, 39, 40,
    148, 103, 189, 140, 86, 75, 227, 119, 194, 127, 127, 127,
    188, 189, 34, 23, 190, 207, 174, 199, 232, 255, 187, 120,
    152, 223, 138, 255, 152, 150, 197, 176, 213, 196, 156, 148,
    247, 182, 210, 199, 199, 199, 219, 219, 141, 158, 218, 229,
    102, 194, 165, 252, 141, 98, 141, 160, 203, 231, 138, 195
  ];
  const out: number[] = [];
  for (let i = 0; i < levelCount; i++) {
    const cycle = Math.floor(i / 24);
    const shift = cycle === 0 ? 1 : cycle % 2 === 1 ? 0.72 : 1.28;
    for (let c = 0; c < 3; c++) out.push(Math.min(255, Math.round(base[(i % 24) * 3 + c] * shift)));
  }
  return out;
}

const rgbAt = (table: Uint8Array, i: number): Rgb => [table[i * 3], table[i * 3 + 1], table[i * 3 + 2]];

/** HSV hue in degrees, or -1 for a grey, which has none. */
function hue([r, g, b]: Rgb): number {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return -1;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('background-aware colours', () => {
  it('is byte-identical to the original palette when no background is given', () => {
    for (const n of [0, 1, 3, 24, 25, 72, 200]) {
      expect(Array.from(paletteFor(n)), `n=${n}`).toEqual(legacyPalette(n));
      expect(Array.from(paletteFor(n, undefined))).toEqual(legacyPalette(n));
    }
  });

  for (const theme of THEMES) {
    it(`${theme.id}: every categorical colour reaches 3:1 against the background`, () => {
      const p = paletteFor(200, theme.background);
      for (let i = 0; i < 200; i++) {
        expect(contrastRatio(rgbAt(p, i), theme.background), `level ${i}`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`${theme.id}: every ramp step reaches 2.5:1 against the background`, () => {
      for (const name of Object.keys(RAMPS)) {
        const ramp = rampFor(name, theme.background);
        expect(ramp.length).toBe(RAMPS[name].length);
        for (let i = 0; i < ramp.length / 3; i++) {
          expect(contrastRatio(rgbAt(ramp, i), theme.background), `${name}[${i}]`).toBeGreaterThanOrEqual(2.5);
        }
      }
    });
  }

  it('leaves colours that already contrast enough untouched', () => {
    for (const theme of THEMES) {
      const plain = paletteFor(72);
      const adjusted = paletteFor(72, theme.background);
      for (let i = 0; i < 72; i++) {
        if (contrastRatio(rgbAt(plain, i), theme.background) >= 3) {
          expect(rgbAt(adjusted, i), `${theme.id} level ${i}`).toEqual(rgbAt(plain, i));
        }
      }
    }
  });

  it('darkens on a light background and lightens on a dark one, keeping the hue', () => {
    const white: Rgb = [255, 255, 255];
    const black: Rgb = [0, 0, 0];
    const plain = paletteFor(72);
    let movedOnWhite = 0;
    let movedOnBlack = 0;
    for (const [bg, dir] of [[white, -1], [black, 1]] as const) {
      const adjusted = paletteFor(72, bg);
      for (let i = 0; i < 72; i++) {
        const before = rgbAt(plain, i);
        const after = rgbAt(adjusted, i);
        if (before.every((v, c) => v === after[c])) continue;
        if (dir < 0) movedOnWhite++;
        else movedOnBlack++;
        for (let c = 0; c < 3; c++) {
          if (dir < 0) expect(after[c]).toBeLessThanOrEqual(before[c]);
          else expect(after[c]).toBeGreaterThanOrEqual(before[c]);
        }
        const h0 = hue(before);
        const h1 = hue(after);
        if (h0 >= 0 && h1 >= 0) {
          const dh = Math.min(Math.abs(h0 - h1), 360 - Math.abs(h0 - h1));
          // Byte rounding of a darkened channel nudges the hue a little, no more.
          expect(dh, `level ${i}`).toBeLessThan(6);
        }
        // Small steps: the colour stops soon after it clears the bar rather
        // than being driven all the way to black or white.
        expect(contrastRatio(after, bg), `level ${i}`).toBeLessThan(3.5);
      }
    }
    // The pale hues fail on white and the darkened cycle fails on black.
    expect(movedOnWhite).toBeGreaterThan(0);
    expect(movedOnBlack).toBeGreaterThan(0);
  });

  it('looks ramps up by name, falling back to viridis for anything unknown', () => {
    expect(rampFor('viridis')).toBe(VIRIDIS);
    expect(rampFor('magma')).toBe(MAGMA);
    expect(rampFor('nope')).toBe(VIRIDIS);
    // Inherited object keys are not ramp names.
    expect(rampFor('constructor')).toBe(VIRIDIS);
    expect(rampFor('toString', [255, 255, 255])).toBe(rampFor('viridis', [255, 255, 255]));
  });

  it('caches an adjusted ramp per name and background', () => {
    const white: Rgb = [255, 255, 255];
    const a = rampFor('magma', white);
    expect(rampFor('magma', [255, 255, 255])).toBe(a);
    expect(rampFor('magma', [0, 0, 0])).not.toBe(a);
    expect(rampFor('viridis', white)).not.toBe(a);
    // Magma's near-black low end is lifted on black; its pale top is darkened on white.
    expect(rampFor('magma', [0, 0, 0])[0]).toBeGreaterThan(MAGMA[0]);
    expect(a[a.length - 3]).toBeLessThan(MAGMA[MAGMA.length - 3]);
    // The shared base ramps are never mutated.
    expect(MAGMA.slice(0, 3)).toEqual(Uint8Array.from([0, 0, 4]));
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

  it('fades unselected cells toward a light background, not toward black (UI-2)', () => {
    const s = store();
    const white = [255, 255, 255] as const;
    recolorCategorical(s, 'cell_type', 255, 0, {
      mask: new Uint8Array([1, 0, 0, 0, 0, 0]),
      factor: 0.25,
      background: white
    });
    // Cell 1 is level B; its green channel has room to move toward white.
    const base = paletteFor(3, [255, 255, 255])[4];
    expect(s.color[5]).toBe(Math.trunc(base * 0.25 + 255 * 0.75));
    expect(s.color[5]).toBeGreaterThan(base);
    // Selected cells keep their exact (background-adjusted) palette colour.
    expect(s.color[0]).toBe(paletteFor(3, [255, 255, 255])[0]);
  });

  it('paints categories with the background-adjusted palette, selected or not', () => {
    const s = store();
    const white = [255, 255, 255] as const;
    const adjusted = paletteFor(3, [255, 255, 255]);
    // Level B (orange) is below 3:1 on white, so the adjustment must show.
    expect(Array.from(adjusted.slice(3, 6))).not.toEqual(Array.from(paletteFor(3).slice(3, 6)));
    recolorCategorical(s, 'cell_type', 255, 0, { mask: null, factor: 0.25, background: white });
    for (let i = 0; i < 6; i++) {
      const p = (i % 3) * 3;
      expect(Array.from(s.color.slice(i * 4, i * 4 + 3))).toEqual(Array.from(adjusted.slice(p, p + 3)));
    }
    recolorCategorical(s, 'cell_type', 255, 0, {
      mask: new Uint8Array([0, 1, 0, 0, 0, 0]),
      factor: 0.25,
      background: white
    });
    expect(Array.from(s.color.slice(4, 7))).toEqual(Array.from(adjusted.slice(3, 6)));
    // Cell 4 (level B, unselected) fades from the adjusted colour, not the raw one.
    expect(s.color[16]).toBe(Math.trunc(adjusted[3] * 0.25 + 255 * 0.75));
  });

  it('adjusts whatever ramp a numeric colouring is given, not only the named ones', () => {
    const s = store();
    // A pale custom ramp: every step is below 2.5:1 on white.
    const pale = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) pale.set([255, 230 - Math.floor(i / 8), 180], i * 3);
    const white: Rgb = [255, 255, 255];
    recolorNumeric(s, 'pseudotime', pale, 255, 0, { mask: null, factor: 0.25, background: white });
    for (let i = 0; i < 6; i++) {
      const rgb: Rgb = [s.color[i * 4], s.color[i * 4 + 1], s.color[i * 4 + 2]];
      expect(contrastRatio(rgb, white), `cell ${i}`).toBeGreaterThanOrEqual(2.5);
    }
    // Without a background the ramp is used as given.
    recolorNumeric(s, 'pseudotime', pale);
    expect(Array.from(s.color.slice(0, 3))).toEqual([255, 230, 180]);
  });

  it('lifts a constant colour that would vanish into the background', () => {
    const s = store();
    const yellow: Rgb = [253, 246, 227];
    recolorConstant(s, [250, 240, 200], 255, 0, { mask: null, factor: 0.5, background: yellow });
    const rgb: Rgb = [s.color[0], s.color[1], s.color[2]];
    expect(contrastRatio(rgb, yellow)).toBeGreaterThanOrEqual(3);
    expect(s.color[3]).toBe(255);
  });

  it('gives legend swatches the same adjusted colours the plot uses', () => {
    const white: Rgb = [255, 255, 255];
    const entries = legendEntries(store(), 'cell_type', null, white);
    const adjusted = paletteFor(3, white);
    expect(entries.map(e => e.rgb)).toEqual([0, 1, 2].map(i => rgbAt(adjusted, i)));
    expect(entries.map(e => e.count)).toEqual([2, 2, 2]);
    // Without a background the swatches are the plain palette.
    expect(legendEntries(store(), 'cell_type').map(e => e.rgb)).toEqual([0, 1, 2].map(i => rgbAt(paletteFor(3), i)));
  });

  it('fades a numeric colouring toward the background too', () => {
    const s = store();
    recolorNumeric(s, 'pseudotime', undefined, 255, 0, {
      mask: new Uint8Array([1, 0, 0, 0, 0, 0]),
      factor: 0.2,
      background: [253, 246, 227]
    });
    // Cell 1's dimmed red sits between its (adjusted) ramp colour and the background.
    const out = new Uint8Array(4);
    rampSample(rampFor('viridis', [253, 246, 227]), 0.2, out, 0);
    expect(s.color[4]).toBe(Math.trunc(out[0] * 0.2 + 253 * 0.8));
  });

  it('gives hidden cells alpha 0 and visible ones full alpha (UI-3)', () => {
    const s = store();
    const visible = new Uint8Array([1, 0, 1, 0, 1, 1]);
    recolorCategorical(s, 'cell_type', 255, 0, { mask: null, factor: 0.22, visible });
    expect([0, 1, 2, 3, 4, 5].map(i => s.color[i * 4 + 3])).toEqual([255, 0, 255, 0, 255, 255]);
    recolorNumeric(s, 'pseudotime', undefined, 255, 0, { mask: null, factor: 0.22, visible });
    expect([0, 1, 2, 3, 4, 5].map(i => s.color[i * 4 + 3])).toEqual([255, 0, 255, 0, 255, 255]);
  });

  it('paints an annotation-free dataset one visible colour, dimmed toward the background', () => {
    const s = store();
    recolorConstant(s, [100, 150, 200], 255, 0, {
      mask: new Uint8Array([1, 0, 1, 1, 1, 1]),
      factor: 0.5,
      background: [255, 255, 255],
      visible: new Uint8Array([1, 1, 1, 1, 1, 0])
    });
    expect(Array.from(s.color.slice(0, 4))).toEqual([100, 150, 200, 255]);
    expect(Array.from(s.color.slice(4, 8))).toEqual([177, 202, 227, 255]);
    expect(s.color[5 * 4 + 3]).toBe(0);
  });

  it('keeps hidden cells hidden through the translucent alpha pass', () => {
    const s = store();
    recolorCategorical(s, 'cell_type');
    applySelectionMask(s.color, new Uint8Array([1, 1, 0, 0, 0, 0]), 40, 255, 6, new Uint8Array([1, 0, 1, 1, 1, 1]));
    expect([0, 1, 2].map(i => s.color[i * 4 + 3])).toEqual([255, 0, 40]);
  });

  it('counts only visible cells when a visibility mask is given', () => {
    const entries = legendEntries(store(), 'cell_type', new Uint8Array([1, 0, 0, 1, 1, 0]));
    expect(entries.map(e => e.count)).toEqual([2, 1, 0]);
  });

  it('builds legend entries with counts that sum to the loaded count', () => {
    const entries = legendEntries(store(), 'cell_type');
    expect(entries.map(e => e.label)).toEqual(['A', 'B', 'C']);
    expect(entries.reduce((a, e) => a + e.count, 0)).toBe(6);
  });
});
