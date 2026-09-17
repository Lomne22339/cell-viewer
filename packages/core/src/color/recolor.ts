import type { CellStore } from '../data/schema';
import { paletteFor, rampSample, VIRIDIS } from './palette';

/**
 * How a selection highlight is drawn.
 *
 * Dimming by alpha requires the renderer to blend, and blending a million
 * overlapping points is the single most expensive thing this viewer does — on
 * an Apple M4 it costs four times the frame rate (see
 * docs/benchmarks/2026-09-07-capacity.md). Dimming by darkening the colour
 * toward the background instead keeps every point fully opaque, so blending
 * can stay off and the highlight still reads.
 */
export interface DimOptions {
  /** 1 = selected, 0 = not. Null means nothing is selected. */
  mask: Uint8Array | null;
  /** Multiplier applied to unselected RGB. 0 = background, 1 = no dimming. */
  factor: number;
}

const DEFAULT_DIM: DimOptions = { mask: null, factor: 0.22 };

/**
 * Fills `store.color` from a categorical field.
 *
 * This is the hot path for a colour-by change: at five million cells it
 * writes twenty megabytes. It is a single flat loop with no allocation and
 * no function calls per cell.
 */
export function recolorCategorical(
  store: CellStore,
  field: string,
  alpha = 255,
  from = 0,
  dim: DimOptions = DEFAULT_DIM
): void {
  const codes = store.codes.get(field);
  if (!codes) throw new Error(`unknown categorical field: ${field}`);
  const levels = Math.max(1, store.levels.get(field)!.length);
  const palette = paletteFor(levels);
  const color = store.color;
  const upTo = store.loadedCount;
  const mask = dim.mask;
  const f = dim.factor;
  for (let i = Math.max(0, from); i < upTo; i++) {
    const p = (codes[i] % levels) * 3;
    const o = i * 4;
    // Recomputed from the source codes every pass, so dimming never compounds.
    const k = mask === null || mask[i] ? 1 : f;
    color[o] = palette[p] * k;
    color[o + 1] = palette[p + 1] * k;
    color[o + 2] = palette[p + 2] * k;
    color[o + 3] = alpha;
  }
  // The tail is left alone deliberately. `color` is allocated zeroed and only
  // ever written across [0, loadedCount), which never shrinks, so the unloaded
  // remainder is already transparent. Re-zeroing it here would rewrite forty
  // megabytes on every chunk of a ten-million-cell load.
}

export function recolorNumeric(
  store: CellStore,
  field: string,
  ramp: Uint8Array = VIRIDIS,
  alpha = 255,
  from = 0,
  dim: DimOptions = DEFAULT_DIM
): void {
  const values = store.numeric.get(field);
  if (!values) throw new Error(`unknown numeric field: ${field}`);
  const [lo, hi] = store.numericRange.get(field) ?? [0, 1];
  // A constant field has zero span; scaling by 1/0 would paint every cell NaN.
  const span = hi - lo;
  const inv = span > 0 ? 1 / span : 0;
  const color = store.color;
  const upTo = store.loadedCount;
  const mask = dim.mask;
  const f = dim.factor;
  for (let i = Math.max(0, from); i < upTo; i++) {
    const o = i * 4;
    rampSample(ramp, (values[i] - lo) * inv, color, o);
    if (mask !== null && !mask[i]) {
      color[o] *= f;
      color[o + 1] *= f;
      color[o + 2] *= f;
    }
    color[o + 3] = alpha;
  }
  // See the note in recolorCategorical: the unloaded tail is already zeroed.
}

/**
 * Alpha-based highlight, kept for the translucent rendering mode.
 *
 * Only usable while blending is on. The opaque path dims through the colour
 * itself instead — see `DimOptions`.
 */
export function applySelectionMask(
  color: Uint8Array,
  mask: Uint8Array | null,
  dimAlpha: number,
  fullAlpha: number,
  upTo = color.length / 4
): void {
  if (mask === null) {
    for (let i = 0; i < upTo; i++) color[i * 4 + 3] = fullAlpha;
    return;
  }
  for (let i = 0; i < upTo; i++) {
    color[i * 4 + 3] = mask[i] ? fullAlpha : dimAlpha;
  }
}

export interface LegendEntry {
  label: string;
  rgb: [number, number, number];
  count: number;
}

export function legendEntries(store: CellStore, field: string): LegendEntry[] {
  const codes = store.codes.get(field);
  if (!codes) throw new Error(`unknown categorical field: ${field}`);
  const labels = store.levels.get(field)!;
  const palette = paletteFor(labels.length);
  const counts = new Uint32Array(labels.length);
  const upTo = store.loadedCount;
  for (let i = 0; i < upTo; i++) counts[codes[i] % labels.length]++;
  return labels.map((label, i) => ({
    label,
    rgb: [palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]] as [number, number, number],
    count: counts[i]
  }));
}
