import type { Manifest } from './manifest';

/** Columnar container for every cell: no per-cell objects, every column is a typed array. */
export class CellStore {
  readonly datasetId: string;
  readonly version: string;
  readonly n: number;
  readonly bounds: [number, number, number, number];
  readonly chunkSize: number;
  readonly chunks: number;
  readonly xy: Float32Array;
  readonly codes = new Map<string, Uint16Array>();
  readonly levels = new Map<string, string[]>();
  readonly numeric = new Map<string, Float32Array>();
  readonly numericRange = new Map<string, [number, number]>();
  readonly color: Uint8Array;
  /** Length of the fully-written prefix: `[0, loadedCount)` is the only real data. */
  loadedCount = 0;
  loadedChunks = 0;
  failedChunks: number[] = [];
  private readonly chunkLoaded: Uint8Array;
  private prefixChunks = 0;

  constructor(m: Manifest) {
    this.datasetId = m.datasetId;
    this.version = typeof m.version === 'string' ? m.version : '';
    this.n = m.n;
    this.bounds = m.bounds;
    this.chunkSize = m.chunkSize;
    this.chunks = m.chunks;
    this.xy = new Float32Array(m.n * 2);
    this.color = new Uint8Array(m.n * 4);
    this.chunkLoaded = new Uint8Array(m.chunks);
    for (const [field, spec] of Object.entries(m.categorical)) {
      this.codes.set(field, new Uint16Array(m.n));
      this.levels.set(field, spec.levels);
    }
    for (const [field, spec] of Object.entries(m.numeric)) {
      this.numeric.set(field, new Float32Array(m.n));
      this.numericRange.set(field, [spec.min, spec.max]);
    }
  }

  markChunkLoaded(c: number): void {
    if (c < 0 || c >= this.chunks || this.chunkLoaded[c]) return;
    this.chunkLoaded[c] = 1;
    this.loadedChunks++;
    let next = this.prefixChunks;
    while (next < this.chunks && this.chunkLoaded[next]) next++;
    this.prefixChunks = next;
    this.loadedCount = Math.min(this.n, next * this.chunkSize);
  }

  isComplete(): boolean {
    return this.loadedChunks === this.chunks;
  }

  chunkRange(c: number): { start: number; count: number } {
    const start = c * this.chunkSize;
    return { start, count: Math.max(0, Math.min(this.chunkSize, this.n - start)) };
  }

  // Ids are made on demand: a million strings up front would outweigh every typed array.
  sampleIds(indices: Uint32Array, max: number): string[] {
    const take = Math.min(max, indices.length);
    const out = new Array<string>(take);
    for (let i = 0; i < take; i++) out[i] = `cell_${indices[i]}`;
    return out;
  }

  categoricalFields(): string[] {
    return [...this.codes.keys()];
  }

  numericFields(): string[] {
    return [...this.numeric.keys()];
  }
}

export function allocateStore(m: Manifest): CellStore {
  return new CellStore(m);
}
