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
  numericStats: Record<
    string,
    { min: number; max: number; mean: number; q: [number, number, number] }
  >;
  sampleIds: string[];
  colorBy: string;
}

export interface ContextMeta {
  datasetId: string;
  view: 'embedding' | 'trajectory';
  colorBy: string;
}

function quartiles(values: Float64Array): [number, number, number] {
  const sorted = values.slice().sort();
  const at = (f: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(f * (sorted.length - 1))))];
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
  for (const [field, codes] of store.codes) {
    const labels = store.levels.get(field)!;
    const counts = new Uint32Array(labels.length);
    for (let k = 0; k < n; k++) counts[codes[idx[k]] % labels.length]++;
    const out: Record<string, number> = {};
    // Zero-count levels are omitted: a donor list of 400 mostly-empty entries
    // is noise in a prompt.
    for (let i = 0; i < labels.length; i++) if (counts[i] > 0) out[labels[i]] = counts[i];
    breakdown[field] = out;
  }

  const numericStats: SelectionContext['numericStats'] = {};
  for (const [field, values] of store.numeric) {
    const picked = new Float64Array(n);
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const v = values[idx[k]];
      picked[k] = v;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    numericStats[field] = {
      min: n ? min : 0,
      max: n ? max : 0,
      mean: n ? sum / n : 0,
      q: n ? quartiles(picked) : [0, 0, 0]
    };
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
    numericStats,
    sampleIds: store.sampleIds(sampled, take),
    colorBy: meta.colorBy
  };
}
