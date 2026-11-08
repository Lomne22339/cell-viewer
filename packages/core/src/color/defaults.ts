import type { CellStore } from '../data/schema';

export interface ColorChoice {
  field: string;
  kind: 'categorical' | 'numeric';
}

/**
 * The field a dataset should open coloured by.
 *
 * A dataset is not required to have any categorical annotation — a Parquet
 * file of `x, y, pseudotime` is perfectly valid — and picking a categorical
 * field unconditionally leaves such a dataset with no colour written at all,
 * which renders as a blank canvas rather than as an error.
 */
export function defaultColorField(store: CellStore): ColorChoice | null {
  const categorical = store.categoricalFields()[0];
  if (categorical) return { field: categorical, kind: 'categorical' };
  const numeric = store.numericFields()[0];
  if (numeric) return { field: numeric, kind: 'numeric' };
  return null;
}
