import type { CellStore } from '../data/schema';

export type FilterListener = () => void;

/**
 * Which categorical levels are hidden, per field — the state behind a
 * Plotly-style interactive legend.
 *
 * Filters belong to their field, not to the colour-by: hiding every cell type
 * but T cells and then colouring by tissue keeps the T-cell filter, which is
 * how a user asks "which tissues do my T cells come from". Several fields can
 * be filtered at once; a cell is visible only if every filter admits it.
 *
 * State is one byte per level, never per cell. The per-cell mask is derived
 * on demand by `computeVisibility`.
 */
export class CategoryFilter {
  private hidden = new Map<string, Uint8Array>();
  private listeners = new Set<FilterListener>();
  /** Bumped on every change, so consumers can cheaply detect staleness. */
  version = 0;

  constructor(private levels: ReadonlyMap<string, readonly string[]>) {}

  private table(field: string): Uint8Array {
    let t = this.hidden.get(field);
    if (!t) {
      const n = this.levels.get(field)?.length;
      if (n === undefined) throw new Error(`unknown categorical field: ${field}`);
      t = new Uint8Array(n);
      this.hidden.set(field, t);
    }
    return t;
  }

  isHidden(field: string, code: number): boolean {
    return this.hidden.get(field)?.[code] === 1;
  }

  hiddenCodes(field: string): number[] {
    const t = this.hidden.get(field);
    const out: number[] = [];
    if (t) for (let c = 0; c < t.length; c++) if (t[c]) out.push(c);
    return out;
  }

  /** Plotly `itemclick: "toggle"`. */
  toggle(field: string, code: number): void {
    const t = this.table(field);
    t[code] = t[code] ? 0 : 1;
    this.changed();
  }

  /**
   * Plotly `itemdoubleclick: "toggleothers"`: show only this level, or — if it
   * already is the only one showing — show everything again.
   */
  isolate(field: string, code: number): void {
    const t = this.table(field);
    let othersAllHidden = !t[code];
    if (othersAllHidden) {
      for (let c = 0; c < t.length; c++) {
        if (c !== code && !t[c]) {
          othersAllHidden = false;
          break;
        }
      }
    }
    if (othersAllHidden) t.fill(0);
    else {
      t.fill(1);
      t[code] = 0;
    }
    this.changed();
  }

  /** Hides exactly `codes` for this field and shows the rest. */
  setHidden(field: string, codes: Iterable<number>): void {
    const t = this.table(field);
    t.fill(0);
    for (const c of codes) if (c >= 0 && c < t.length) t[c] = 1;
    this.changed();
  }

  showAll(field?: string): void {
    if (field === undefined) this.hidden.clear();
    else this.hidden.delete(field);
    this.changed();
  }

  hideAll(field: string): void {
    this.table(field).fill(1);
    this.changed();
  }

  /** Fields with at least one hidden level, in insertion order. */
  activeFields(): string[] {
    return [...this.hidden.entries()].filter(([, t]) => t.includes(1)).map(([f]) => f);
  }

  isActive(): boolean {
    return this.activeFields().length > 0;
  }

  subscribe(fn: FilterListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private changed(): void {
    this.version++;
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error('filter listener failed', err);
      }
    }
  }

  /** Read-only view of the per-level table, for the visibility pass. */
  hiddenTable(field: string): Uint8Array | undefined {
    return this.hidden.get(field);
  }
}

/**
 * Per-cell visibility over the loaded prefix: 1 = drawn, 0 = filtered out.
 *
 * Returns null when no filter is active, so the common case costs nothing and
 * downstream code can skip the per-cell test entirely. Otherwise this is one
 * flat pass per filtered field — the same cost class as a colour-by change.
 */
export function computeVisibility(
  store: Pick<CellStore, 'codes' | 'loadedCount' | 'n'>,
  filter: CategoryFilter,
  out?: Uint8Array,
  /**
   * Ignore this field's own filter. The legend uses it to count each level as
   * if that level were switched on, which is what a hidden row should report.
   */
  excludeField?: string
): Uint8Array | null {
  const fields = filter.activeFields().filter(f => f !== excludeField);
  if (fields.length === 0) return null;
  const vis = out && out.length >= store.n ? out : new Uint8Array(store.n);
  const upTo = store.loadedCount;
  vis.fill(1, 0, upTo);
  vis.fill(0, upTo);
  for (const field of fields) {
    const codes = store.codes.get(field);
    const hidden = filter.hiddenTable(field);
    if (!codes || !hidden) continue;
    const levels = hidden.length;
    for (let i = 0; i < upTo; i++) {
      const c = codes[i];
      if (c < levels && hidden[c]) vis[i] = 0;
    }
  }
  return vis;
}

/** The members of `indices` that are visible. Passes `indices` through when nothing is filtered. */
export function filterIndices(indices: Uint32Array, visible: Uint8Array | null): Uint32Array {
  if (visible === null) return indices;
  let k = 0;
  for (let j = 0; j < indices.length; j++) if (visible[indices[j]]) k++;
  if (k === indices.length) return indices;
  const out = new Uint32Array(k);
  k = 0;
  for (let j = 0; j < indices.length; j++) {
    const i = indices[j];
    if (visible[i]) out[k++] = i;
  }
  return out;
}

/** Hidden level labels per filtered field, for describing the filter in words. */
export function hiddenLabels(
  filter: CategoryFilter,
  levels: ReadonlyMap<string, readonly string[]>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const field of filter.activeFields()) {
    const names = levels.get(field) ?? [];
    out[field] = filter.hiddenCodes(field).map(c => names[c] ?? String(c));
  }
  return out;
}

/** Number of visible cells among the first `upTo`. */
export function countVisible(visible: Uint8Array | null, upTo: number): number {
  if (visible === null) return upTo;
  let k = 0;
  for (let i = 0; i < upTo; i++) k += visible[i];
  return k;
}
