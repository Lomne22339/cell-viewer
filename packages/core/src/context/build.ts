import type { CellStore } from '../data/schema';
import type { Selection } from '../select/store';

export interface SelectionContext {
  datasetId: string;
  view: 'embedding' | 'trajectory';
  n: number;
  totalN: number;
  bbox: [number, number, number, number];
  centroid: [number, number];
  breakdown: Record<string, Record<string, number>>;
  omittedLevels: Record<string, number>;
  numericStats: Record<
    string,
    { min: number; max: number; mean: number; q: [number, number, number] }
  >;
  sampleIds: string[];
  colorBy: string;
  visibleN: number;
  hidden: Record<string, string[]>;
}

export interface ContextMeta {
  datasetId: string;
  view: 'embedding' | 'trajectory';
  colorBy: string;
  visibleN?: number;
  hidden?: Record<string, string[]>;
}

/** Levels per field listed by name; more would exceed the server's 32,000-byte context limit. */
export const MAX_CONTEXT_LEVELS = 50;

/** Q1, median, Q3 as `numpy.quantile` computes them by default, so quoted numbers match a notebook. */
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

  // Non-finite values are skipped: one NaN would make every statistic NaN (null in JSON).
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
