/**
 * Colour tables as flat RGB byte triplets.
 *
 * These are consumed inside per-cell loops that run over millions of
 * elements, so they are plain Uint8Arrays indexed arithmetically rather
 * than arrays of objects or CSS strings.
 */

/** 24 hues chosen to stay distinguishable at one-pixel point size. */
const BASE_CATEGORICAL: number[] = [
  31, 119, 180, 255, 127, 14, 44, 160, 44, 214, 39, 40,
  148, 103, 189, 140, 86, 75, 227, 119, 194, 127, 127, 127,
  188, 189, 34, 23, 190, 207, 174, 199, 232, 255, 187, 120,
  152, 223, 138, 255, 152, 150, 197, 176, 213, 196, 156, 148,
  247, 182, 210, 199, 199, 199, 219, 219, 141, 158, 218, 229,
  102, 194, 165, 252, 141, 98, 141, 160, 203, 231, 138, 195
];

/** Module-private: `paletteFor` is the entry point callers should use. */
const CATEGORICAL_PALETTE = new Uint8Array(BASE_CATEGORICAL);

/**
 * Palette sized to the level count. Beyond 24 levels the hues repeat with a
 * brightness shift; distinguishing more than that by colour alone does not
 * work anyway, and the legend carries the labels.
 */
export function paletteFor(levelCount: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, levelCount) * 3);
  const base = CATEGORICAL_PALETTE.length / 3;
  for (let i = 0; i < levelCount; i++) {
    const cycle = Math.floor(i / base);
    const shift = cycle === 0 ? 1 : cycle % 2 === 1 ? 0.72 : 1.28;
    const b = (i % base) * 3;
    out[i * 3] = Math.min(255, Math.round(CATEGORICAL_PALETTE[b] * shift));
    out[i * 3 + 1] = Math.min(255, Math.round(CATEGORICAL_PALETTE[b + 1] * shift));
    out[i * 3 + 2] = Math.min(255, Math.round(CATEGORICAL_PALETTE[b + 2] * shift));
  }
  return out;
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

/** Writes RGB for position `t` in [0,1] into `out` at `offset`. Clamps. */
export function rampSample(ramp: Uint8Array, t: number, out: Uint8Array, offset: number): void {
  const steps = ramp.length / 3;
  let i = Math.round(t * (steps - 1));
  if (!(i >= 0)) i = 0; // also catches NaN
  if (i > steps - 1) i = steps - 1;
  out[offset] = ramp[i * 3];
  out[offset + 1] = ramp[i * 3 + 1];
  out[offset + 2] = ramp[i * 3 + 2];
}
