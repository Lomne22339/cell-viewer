/**
 * Uniform bucket grid in compressed-sparse-row form.
 *
 * Two linear passes and two allocations; no nested arrays, because one
 * array per bin at a few hundred thousand bins costs more than the point
 * data itself. `starts` holds bin offsets into `items`, and `items` holds
 * point indices grouped by bin.
 */
export class UniformGrid {
  constructor(
    readonly cols: number,
    readonly rows: number,
    readonly cellSize: number,
    readonly minX: number,
    readonly minY: number,
    readonly starts: Uint32Array,
    readonly items: Uint32Array
  ) {}

  colOf(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cellSize)));
  }

  rowOf(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cellSize)));
  }

  /** Bin index range covering a world-space bounding box. */
  binRange(b: [number, number, number, number]): { c0: number; c1: number; r0: number; r1: number } {
    return {
      c0: this.colOf(b[0]),
      c1: this.colOf(b[2]),
      r0: this.rowOf(b[1]),
      r1: this.rowOf(b[3])
    };
  }
}

export function buildGrid(xy: Float32Array, count: number, targetPerBin = 32): UniformGrid {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = xy[i * 2];
    const y = xy[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = 1;
    minY = 0;
    maxY = 1;
  }

  // A degenerate extent (every point identical) would otherwise give a zero
  // cell size and an infinite column count.
  const w = Math.max(maxX - minX, 1e-6);
  const h = Math.max(maxY - minY, 1e-6);
  const targetBins = Math.max(1, Math.ceil(count / targetPerBin));
  const cellSize = Math.max(Math.sqrt((w * h) / targetBins), 1e-6);
  const cols = Math.max(1, Math.min(4096, Math.ceil(w / cellSize)));
  const rows = Math.max(1, Math.min(4096, Math.ceil(h / cellSize)));
  const nbins = cols * rows;

  const starts = new Uint32Array(nbins + 1);
  const binOf = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const c = Math.min(cols - 1, Math.max(0, Math.floor((xy[i * 2] - minX) / cellSize)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor((xy[i * 2 + 1] - minY) / cellSize)));
    const b = r * cols + c;
    binOf[i] = b;
    starts[b + 1]++;
  }
  for (let b = 0; b < nbins; b++) starts[b + 1] += starts[b];

  const cursor = starts.slice(0, nbins);
  const items = new Uint32Array(count);
  for (let i = 0; i < count; i++) items[cursor[binOf[i]]++] = i;

  return new UniformGrid(cols, rows, cellSize, minX, minY, starts, items);
}
