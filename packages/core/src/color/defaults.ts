import type { CellStore } from '../data/schema';

export interface ColorChoice {
  field: string;
  kind: 'categorical' | 'numeric';
}

/** The field a dataset opens colored by, or null when it has no categorical annotation. */
export function defaultColorField(store: CellStore): ColorChoice | null {
  const categorical = store.categoricalFields()[0];
  if (categorical) return { field: categorical, kind: 'categorical' };
  const numeric = store.numericFields()[0];
  if (numeric) return { field: numeric, kind: 'numeric' };
  return null;
}
