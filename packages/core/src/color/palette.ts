/** Color tables as flat RGB byte triplets (Uint8Array), consumed in per-cell loops. */
import { contrastRatio, relativeLuminance, type Rgb } from '../theme/themes';

const BASE_CATEGORICAL: number[] = [
  31, 119, 180, 255, 127, 14, 44, 160, 44, 214, 39, 40,
  148, 103, 189, 140, 86, 75, 227, 119, 194, 127, 127, 127,
  188, 189, 34, 23, 190, 207, 174, 199, 232, 255, 187, 120,
  152, 223, 138, 255, 152, 150, 197, 176, 213, 196, 156, 148,
  247, 182, 210, 199, 199, 199, 219, 219, 141, 158, 218, 229,
  102, 194, 165, 252, 141, 98, 141, 160, 203, 231, 138, 195
];

const BASE_HUES = BASE_CATEGORICAL.length / 3;

const VARIANTS = (() => {
  const out = new Uint8Array(BASE_HUES * 3 * 3);
  [1, 0.72, 1.28].forEach((shift, v) => {
    for (let k = 0; k < BASE_CATEGORICAL.length; k++) {
      out[v * BASE_CATEGORICAL.length + k] = Math.min(255, Math.round(BASE_CATEGORICAL[k] * shift));
    }
  });
  return out;
})();

const CATEGORICAL_MIN_CONTRAST = 3;
// Lower than categorical: a ramp is read by gradient, and 3:1 would flatten viridis' bright end.
const RAMP_MIN_CONTRAST = 2.5;
const ADJUST_STEPS = 50;

function adjustTable(table: Uint8Array, background: Rgb, minRatio: number): Uint8Array {
  const lum = relativeLuminance(background);
  const darken = (lum + 0.05) / 0.05 > 1.05 / (lum + 0.05);
  const out = table.slice();
  const rgb: Rgb = [0, 0, 0];
  for (let o = 0; o + 2 < table.length; o += 3) {
    const r = table[o];
    const g = table[o + 1];
    const b = table[o + 2];
    rgb[0] = r;
    rgb[1] = g;
    rgb[2] = b;
    for (let step = 1; step <= ADJUST_STEPS && contrastRatio(rgb, background) < minRatio; step++) {
      const t = step / ADJUST_STEPS;
      if (darken) {
        rgb[0] = Math.round(r * (1 - t));
        rgb[1] = Math.round(g * (1 - t));
        rgb[2] = Math.round(b * (1 - t));
      } else {
        rgb[0] = Math.round(r + (255 - r) * t);
        rgb[1] = Math.round(g + (255 - g) * t);
        rgb[2] = Math.round(b + (255 - b) * t);
      }
    }
    out[o] = rgb[0];
    out[o + 1] = rgb[1];
    out[o + 2] = rgb[2];
  }
  return out;
}

const adjusted = new WeakMap<Uint8Array, Map<string, Uint8Array>>();

function adjustForBackground(table: Uint8Array, background: Rgb, minRatio: number): Uint8Array {
  const key = `${minRatio}|${background[0]},${background[1]},${background[2]}`;
  let perTable = adjusted.get(table);
  if (!perTable) {
    perTable = new Map();
    adjusted.set(table, perTable);
  }
  let out = perTable.get(key);
  if (!out) {
    out = adjustTable(table, background, minRatio);
    perTable.set(key, out);
  }
  return out;
}

export function paletteFor(levelCount: number, background?: Rgb): Uint8Array {
  const table = background ? adjustForBackground(VARIANTS, background, CATEGORICAL_MIN_CONTRAST) : VARIANTS;
  const out = new Uint8Array(Math.max(0, levelCount) * 3);
  for (let i = 0; i < levelCount; i++) {
    const cycle = Math.floor(i / BASE_HUES);
    const variant = cycle === 0 ? 0 : cycle % 2 === 1 ? 1 : 2;
    const b = (variant * BASE_HUES + (i % BASE_HUES)) * 3;
    out[i * 3] = table[b];
    out[i * 3 + 1] = table[b + 1];
    out[i * 3 + 2] = table[b + 2];
  }
  return out;
}

export function adjustRamp(ramp: Uint8Array, background: Rgb): Uint8Array {
  return adjustForBackground(ramp, background, RAMP_MIN_CONTRAST);
}

export function adjustColor(rgb: readonly [number, number, number], background: Rgb): Rgb {
  const one = adjustTable(Uint8Array.from(rgb), background, CATEGORICAL_MIN_CONTRAST);
  return [one[0], one[1], one[2]];
}

function buildRamp(stops: [number, number, number][], steps = 256): Uint8Array {
  const out = new Uint8Array(steps * 3);
  const segs = stops.length - 1;
  for (let i = 0; i < steps; i++) {
    const t = (i / (steps - 1)) * segs;
    const s = Math.min(segs - 1, Math.floor(t));
    const f = t - s;
    for (let c = 0; c < 3; c++) {
      out[i * 3 + c] = Math.round(stops[s][c] + (stops[s + 1][c] - stops[s][c]) * f);
    }
  }
  return out;
}

export const VIRIDIS = buildRamp([
  [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142],
  [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89],
  [180, 222, 44], [253, 231, 37]
]);

export const MAGMA = buildRamp([
  [0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129],
  [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]
]);

export const RAMPS: Record<string, Uint8Array> = { viridis: VIRIDIS, magma: MAGMA };

export function rampFor(name: string, background?: Rgb): Uint8Array {
  // `in` or a bare index would also find `constructor` and friends.
  const ramp = Object.hasOwn(RAMPS, name) ? RAMPS[name] : VIRIDIS;
  return background ? adjustRamp(ramp, background) : ramp;
}

export function rampSample(ramp: Uint8Array, t: number, out: Uint8Array, offset: number): void {
  const steps = ramp.length / 3;
  let i = Math.round(t * (steps - 1));
  if (!(i >= 0)) i = 0; // also catches NaN
  if (i > steps - 1) i = steps - 1;
  out[offset] = ramp[i * 3];
  out[offset + 1] = ramp[i * 3 + 1];
  out[offset + 2] = ramp[i * 3 + 2];
}
