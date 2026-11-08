import type { CellStore } from '../data/schema';
import type { Selection } from '../select/store';

export interface SelectionContext {
  datasetId: string;
  view: 'embedding' | 'trajectory';
  n: number;
  totalN: number;
  bbox: [number, number, number, number];
  centroid: [number, number];
  /** Cells per level, for at most `MAX_CONTEXT_LEVELS` levels per field. */
  breakdown: Record<string, Record<string, number>>;
  /**
   * Per field, how many non-empty levels were left out of `breakdown`. Only
   * fields that lost levels appear.
   */
  omittedLevels: Record<string, number>;
  /** Over finite values only; a field with none is left out. */
  numericStats: Record<
    string,
    { min: number; max: number; mean: number; q: [number, number, number] }
  >;
  sampleIds: string[];
  colorBy: string;
  /** Cells visible under the legend filter; equals totalN when nothing is hidden. */
  visibleN: number;
  /** Hidden levels per field, when the legend filter is active. */
  hidden: Record<string, string[]>;
}

export interface ContextMeta {
  datasetId: string;
  view: 'embedding' | 'trajectory';
  colorBy: string;
  visibleN?: number;
  hidden?: Record<string, string[]>;
}

/**
 * Levels per field the context lists by name. A donor or sample field can
 * have thousands of levels; listing them all would push the context past the
 * server's 32,000-byte limit, and the renderer only prints twelve anyway.
 */
export const MAX_CONTEXT_LEVELS = 50;

/**
 * First quartile, median and third quartile, computed exactly as
 * `numpy.quantile` does by default: linear interpolation at `f * (n - 1)`,
 * with the interpolation taken from the upper neighbour once past halfway.
 * That last detail is numpy's, and matching it bit for bit means the numbers
 * the model quotes agree with the ones an analyst gets in a notebook.
 * NaN for an empty input.
 */
export function quartiles(values: Float64Array): [number, number, number] {
  const sorted = values.slice().sort();
  const last = sorted.length - 1;
  const at = (f: number): number => {
    const pos = f * last;
    const lo = Math.floor(pos);
    const hi = Math.min(last, lo + 1);
    const t = pos - lo;
    const a = sorted[lo];
    const b = sorted[hi];
    return t >= 0.5 ? b - (b - a) * (1 - t) : a + (b - a) * t;
  };
  return [at(0.25), at(0.5), at(0.75)];
}

/**
 * Summarises a selection into something a language model can read.
 *
 * A selection of half a million cells and one of twelve produce contexts of
 * nearly identical size: counts per level, a few statistics, and at most a
 * hundred sampled ids. Shipping the rows themselves would make the token
 * cost of a question scale with the size of the lasso, which is exactly the
 * thing this design refuses to do.
 */
export function buildSelectionContext(
  store: CellStore,
  selection: Selection,
  meta: ContextMeta,
  maxSampleIds = 100
): SelectionContext {
  const idx = selection.indices;
  const n = idx.length;

  let sx = 0;
  let sy = 0;
  for (let k = 0; k < n; k++) {
    sx += store.xy[idx[k] * 2];
    sy += store.xy[idx[k] * 2 + 1];
  }

  const breakdown: Record<string, Record<string, number>> = {};
  const omittedLevels: Record<string, number> = {};
  for (const [field, codes] of store.codes) {
    const labels = store.levels.get(field)!;
    const counts = new Uint32Array(labels.length);
    for (let k = 0; k < n; k++) counts[codes[idx[k]] % labels.length]++;
    // Zero-count levels are omitted: a donor list of 400 mostly-empty entries
    // is noise in a prompt. Of the rest, the largest are kept, ties going to
    // the earlier level so the choice is deterministic.
    const present: number[] = [];
    for (let i = 0; i < labels.length; i++) if (counts[i] > 0) present.push(i);
    let kept = present;
    if (present.length > MAX_CONTEXT_LEVELS) {
      kept = present
        .sort((a, b) => counts[b] - counts[a] || a - b)
        .slice(0, MAX_CONTEXT_LEVELS)
        .sort((a, b) => a - b);
      omittedLevels[field] = present.length - MAX_CONTEXT_LEVELS;
    }
    const out: Record<string, number> = {};
    for (const i of kept) out[labels[i]] = counts[i];
    breakdown[field] = out;
  }

  // Non-finite values (a NaN from a missing measurement, an overflowed
  // score) would make every statistic NaN, which JSON then sends as null.
  // They are skipped, and a field with no finite value at all is left out.
  const numericStats: SelectionContext['numericStats'] = {};
  const picked = new Float64Array(n);
  for (const [field, values] of store.numeric) {
    let m = 0;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const v = values[idx[k]];
      if (!Number.isFinite(v)) continue;
      picked[m++] = v;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    if (m === 0) continue;
    numericStats[field] = { min, max, mean: sum / m, q: quartiles(picked.subarray(0, m)) };
  }

  // Stride rather than take the head, so the sample spans the region instead
  // of clustering at whichever corner the indices happen to start in.
  const take = Math.min(maxSampleIds, n);
  const stride = Math.max(1, Math.floor(n / Math.max(1, take)));
  const sampled = new Uint32Array(take);
  for (let k = 0; k < take; k++) sampled[k] = idx[Math.min(n - 1, k * stride)];

  return {
    datasetId: meta.datasetId,
    view: meta.view,
    n,
    totalN: store.n,
    bbox: selection.bbox,
    centroid: [n ? sx / n : 0, n ? sy / n : 0],
    breakdown,
    omittedLevels,
    numericStats,
    sampleIds: store.sampleIds(sampled, take),
    colorBy: meta.colorBy,
    visibleN: meta.visibleN ?? store.n,
    hidden: meta.hidden ?? {}
  };
}
