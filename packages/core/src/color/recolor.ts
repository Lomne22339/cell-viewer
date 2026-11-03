import type { CellStore } from '../data/schema';
import type { Rgb } from '../theme/themes';
import { adjustColor, adjustRamp, paletteFor, rampSample, VIRIDIS } from './palette';

/** Unselected colors dim toward the background, never by alpha, so points stay opaque. */
export interface DimOptions {
  mask: Uint8Array | null;
  factor: number;
  /** Unselected cells fade toward this: the plot background (black would stand out on light themes). */
  background?: readonly [number, number, number];
  /** Legend visibility: 0 hides a cell (alpha 0, culled in the vertex shader). */
  visible?: Uint8Array | null;
}

const DEFAULT_DIM: DimOptions = { mask: null, factor: 0.22 };
const BLACK = [0, 0, 0] as const;

function backgroundOf(dim: DimOptions): Rgb | undefined {
  const b = dim.background;
  return b ? [b[0], b[1], b[2]] : undefined;
}

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
  // Leave the unloaded tail alone: `color` starts zeroed and is only written over [0, loadedCount).
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
}

/** One color for every cell; a zeroed buffer would be alpha 0 and culled. */
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

export function applySelectionMask(
  color: Uint8Array,
  mask: Uint8Array | null,
  dimAlpha: number,
  fullAlpha: number,
  upTo = color.length / 4,
  visible: Uint8Array | null = null
): void {
  // A filtered-out cell stays at alpha 0 whatever the selection says.
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
