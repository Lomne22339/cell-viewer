import type { CellStore } from '../data/schema';
import type { Rgb } from '../theme/themes';
import { adjustColor, adjustRamp, paletteFor, rampSample, VIRIDIS } from './palette';

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
  /** How much of an unselected cell's own colour survives. 0 = background, 1 = no dimming. */
  factor: number;
  /**
   * The colour unselected cells fade toward — the plot background. On a white
   * or light-yellow theme, fading toward black would make the cells that are
   * meant to recede the darkest, most prominent marks on the plot.
   * Defaults to black.
   *
   * When given, the palette or ramp is also adjusted to keep its contrast
   * against this background (see `paletteFor`), so a pale category stays
   * visible on a light theme. Selected cells take the adjusted colour and
   * dimmed ones fade from it.
   */
  background?: readonly [number, number, number];
  /**
   * Per-cell visibility from the legend filter: 0 hides the cell. A hidden cell
   * gets alpha 0, which the renderer culls in the vertex shader, so filtering
   * never needs blending. Null means every cell is visible.
   */
  visible?: Uint8Array | null;
}

const DEFAULT_DIM: DimOptions = { mask: null, factor: 0.22 };
const BLACK = [0, 0, 0] as const;

/** The background colours are adjusted against, or undefined for none. */
function backgroundOf(dim: DimOptions): Rgb | undefined {
  const b = dim.background;
  return b ? [b[0], b[1], b[2]] : undefined;
}

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
  const palette = paletteFor(levels, backgroundOf(dim));
  const color = store.color;
  const upTo = store.loadedCount;
  const mask = dim.mask;
  const visible = dim.visible ?? null;
  const f = dim.factor;
  const [br, bg, bb] = dim.background ?? BLACK;
  // Precomputed so the per-cell work is a multiply-add: c * f + bg * (1 - f).
  const g = 1 - f;
  const r0 = br * g;
  const g0 = bg * g;
  const b0 = bb * g;
  for (let i = Math.max(0, from); i < upTo; i++) {
    const p = (codes[i] % levels) * 3;
    const o = i * 4;
    // Recomputed from the source codes every pass, so dimming never compounds.
    if (mask === null || mask[i]) {
      color[o] = palette[p];
      color[o + 1] = palette[p + 1];
      color[o + 2] = palette[p + 2];
    } else {
      color[o] = palette[p] * f + r0;
      color[o + 1] = palette[p + 1] * f + g0;
      color[o + 2] = palette[p + 2] * f + b0;
    }
    color[o + 3] = visible === null || visible[i] ? alpha : 0;
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
  const background = backgroundOf(dim);
  if (background) ramp = adjustRamp(ramp, background);
  const [lo, hi] = store.numericRange.get(field) ?? [0, 1];
  // A constant field has zero span; scaling by 1/0 would paint every cell NaN.
  const span = hi - lo;
  const inv = span > 0 ? 1 / span : 0;
  const color = store.color;
  const upTo = store.loadedCount;
  const mask = dim.mask;
  const visible = dim.visible ?? null;
  const f = dim.factor;
  const [br, bg, bb] = dim.background ?? BLACK;
  const g = 1 - f;
  const r0 = br * g;
  const g0 = bg * g;
  const b0 = bb * g;
  for (let i = Math.max(0, from); i < upTo; i++) {
    const o = i * 4;
    rampSample(ramp, (values[i] - lo) * inv, color, o);
    if (mask !== null && !mask[i]) {
      color[o] = color[o] * f + r0;
      color[o + 1] = color[o + 1] * f + g0;
      color[o + 2] = color[o + 2] * f + b0;
    }
    color[o + 3] = visible === null || visible[i] ? alpha : 0;
  }
  // See the note in recolorCategorical: the unloaded tail is already zeroed.
}

/**
 * One colour for every cell, for a dataset with no annotation to colour by.
 *
 * Coordinates alone are a valid dataset, and leaving the colour buffer at its
 * zeroed state would give every point alpha 0 — which the renderer culls — so
 * such a dataset needs an explicit colour to be visible at all.
 */
export function recolorConstant(
  store: CellStore,
  rgb: readonly [number, number, number],
  alpha = 255,
  from = 0,
  dim: DimOptions = DEFAULT_DIM
): void {
  const background = backgroundOf(dim);
  if (background) rgb = adjustColor(rgb, background);
  const color = store.color;
  const upTo = store.loadedCount;
  const mask = dim.mask;
  const visible = dim.visible ?? null;
  const f = dim.factor;
  const [br, bg, bb] = dim.background ?? BLACK;
  const dimmed = [rgb[0] * f + br * (1 - f), rgb[1] * f + bg * (1 - f), rgb[2] * f + bb * (1 - f)];
  for (let i = Math.max(0, from); i < upTo; i++) {
    const o = i * 4;
    const c = mask === null || mask[i] ? rgb : dimmed;
    color[o] = c[0];
    color[o + 1] = c[1];
    color[o + 2] = c[2];
    color[o + 3] = visible === null || visible[i] ? alpha : 0;
  }
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
  upTo = color.length / 4,
  visible: Uint8Array | null = null
): void {
  // A filtered-out cell stays at alpha 0 whatever the selection says;
  // otherwise toggling translucency would resurrect hidden cells.
  for (let i = 0; i < upTo; i++) {
    color[i * 4 + 3] =
      visible !== null && !visible[i] ? 0 : mask === null || mask[i] ? fullAlpha : dimAlpha;
  }
}

export interface LegendEntry {
  label: string;
  rgb: [number, number, number];
  count: number;
}

/**
 * One entry per level with its colour and cell count. With `visible`, only
 * visible cells are counted — so "only T cells, coloured by tissue" counts the
 * T cells in each tissue, not every cell. With `background`, swatches use the
 * same background-adjusted palette as `recolorCategorical`, so the legend
 * matches the plot.
 */
export function legendEntries(
  store: CellStore,
  field: string,
  visible: Uint8Array | null = null,
  background?: Rgb
): LegendEntry[] {
  const codes = store.codes.get(field);
  if (!codes) throw new Error(`unknown categorical field: ${field}`);
  const labels = store.levels.get(field)!;
  const palette = paletteFor(labels.length, background);
  const counts = new Uint32Array(labels.length);
  const upTo = store.loadedCount;
  if (visible === null) {
    for (let i = 0; i < upTo; i++) counts[codes[i] % labels.length]++;
  } else {
    for (let i = 0; i < upTo; i++) if (visible[i]) counts[codes[i] % labels.length]++;
  }
  return labels.map((label, i) => ({
    label,
    rgb: [palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]] as [number, number, number],
    count: counts[i]
  }));
}
