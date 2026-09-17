import type { Manifest } from './manifest';

/**
 * Columnar container for every cell in a dataset.
 *
 * There is deliberately no per-cell object anywhere in this class. At one
 * million cells an array of objects costs more time in allocation and GC
 * than the entire render loop, and it is the single mistake that caps most
 * scatter plots at a hundred thousand points.
 */
export class CellStore {
  readonly datasetId: string;
  readonly n: number;
  readonly bounds: [number, number, number, number];
  readonly chunkSize: number;
  readonly chunks: number;
  readonly xy: Float32Array;
  readonly codes = new Map<string, Uint16Array>();
  readonly levels = new Map<string, string[]>();
  readonly numeric = new Map<string, Float32Array>();
  readonly numericRange = new Map<string, [number, number]>();
  /** RGBA, rewritten whenever colour-by or the selection mask changes. */
  readonly color: Uint8Array;
  /**
   * Length of the contiguous, fully-written prefix of every column.
   *
   * Everything downstream — the renderer, the grid index, selection, the chat
   * context — treats `[0, loadedCount)` as real data, so this must never run
   * ahead of what has actually been written. Chunks are fetched in parallel and
   * can complete out of order, so counting bytes received would let cell 0 be
   * "loaded" because chunk 3 arrived, and phantom cells would appear at the
   * origin.
   */
  loadedCount = 0;
  /** Chunks successfully written, in any order. For progress reporting only. */
  loadedChunks = 0;
  failedChunks: number[] = [];
  private readonly chunkLoaded: Uint8Array;
  private prefixChunks = 0;

  constructor(m: Manifest) {
    this.datasetId = m.datasetId;
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

  /**
   * Records a chunk as fully written and advances the contiguous prefix.
   *
   * The prefix only moves when the gap in front of it is filled, so a chunk
   * that arrives early is held back until its predecessors land.
   */
  markChunkLoaded(c: number): void {
    if (c < 0 || c >= this.chunks || this.chunkLoaded[c]) return;
    this.chunkLoaded[c] = 1;
    this.loadedChunks++;
    let next = this.prefixChunks;
    while (next < this.chunks && this.chunkLoaded[next]) next++;
    this.prefixChunks = next;
    this.loadedCount = Math.min(this.n, next * this.chunkSize);
  }

  /** True once every chunk has been written. */
  isComplete(): boolean {
    return this.loadedChunks === this.chunks;
  }

  chunkRange(c: number): { start: number; count: number } {
    const start = c * this.chunkSize;
    return { start, count: Math.max(0, Math.min(this.chunkSize, this.n - start)) };
  }

  /**
   * Ids are generated on demand for at most `max` indices. Building one
   * million strings up front would cost more memory than every typed array
   * in this store combined, and nothing needs them.
   */
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
