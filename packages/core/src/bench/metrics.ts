export interface BenchRow {
  n: number;
  loadMs: number;
  decodeMs: number;
  gridMs: number;
  firstFrameMs: number;
  /** Frames deck.gl actually drew, divided by the wall time of the window. */
  fps: number;
  frames: number;
  /**
   * Worst-5% frame rate, reported only when enough frames were drawn to make a
   * percentile mean anything. At eight frames a median is an artefact, and an
   * earlier version of this table published exactly that artefact as 61 fps
   * for ten million points.
   */
  fpsP5: number | null;
  lassoMs: number;
  heapMb: number;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1)))
  );
  return sorted[i];
}

/**
 * Collects per-frame deltas and reports FPS percentiles.
 *
 * The p5 figure matters more than the mean: a plot that averages 60 fps but
 * stalls for 200 ms whenever a dense region enters the viewport feels
 * broken, and only the low percentile shows that.
 */
export class FrameSampler {
  private deltas: number[] = [];

  pushDelta(ms: number): void {
    if (ms > 0 && Number.isFinite(ms)) this.deltas.push(ms);
  }

  summary(): { p50: number; p5: number; frames: number } {
    const fps = this.deltas.map(d => 1000 / d);
    return {
      p50: Math.round(percentile(fps, 50) * 10) / 10,
      p5: Math.round(percentile(fps, 5) * 10) / 10,
      frames: this.deltas.length
    };
  }
}

export function formatMarkdown(rows: BenchRow[]): string {
  const head =
    '| points | load ms | decode ms | grid ms | first frame ms | fps | frames | fps p5 | lasso ms | heap MB |';
  const sep = '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|';
  const body = rows.map(
    r =>
      `| ${r.n.toLocaleString('en-US')} | ${Math.round(r.loadMs)} | ${Math.round(r.decodeMs)} | ` +
      `${Math.round(r.gridMs)} | ${Math.round(r.firstFrameMs)} | ${r.fps.toFixed(1)} | ` +
      `${r.frames} | ${r.fpsP5 === null ? 'n/a' : r.fpsP5.toFixed(1)} | ` +
      `${r.lassoMs.toFixed(1)} | ${Number.isFinite(r.heapMb) ? Math.round(r.heapMb) : 'n/a'} |`
  );
  return [head, sep, ...body].join('\n');
}

/** Percentiles need enough samples to mean anything. */
export const MIN_FRAMES_FOR_PERCENTILE = 30;
