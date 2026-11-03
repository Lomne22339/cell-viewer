import type { CellStore } from '../data/schema';

export type FilterListener = () => void;

/** Hidden levels per field, one byte per level (never per cell); filters belong to their field. */
export class CategoryFilter {
  private hidden = new Map<string, Uint8Array>();
  private listeners = new Set<FilterListener>();
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

  toggle(field: string, code: number): void {
    const t = this.table(field);
    t[code] = t[code] ? 0 : 1;
    this.changed();
  }

  /** Plotly `itemdoubleclick: "toggleothers"`: show only this level, or all if it already is alone. */
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

  hiddenTable(field: string): Uint8Array | undefined {
    return this.hidden.get(field);
  }
}

/** Per-cell visibility over the loaded prefix (1 = drawn); null when no filter is active. */
export function computeVisibility(
  store: Pick<CellStore, 'codes' | 'loadedCount' | 'n'>,
  filter: CategoryFilter,
  out?: Uint8Array,
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

export function countVisible(visible: Uint8Array | null, upTo: number): number {
  if (visible === null) return upTo;
  let k = 0;
  for (let i = 0; i < upTo; i++) k += visible[i];
  return k;
}
