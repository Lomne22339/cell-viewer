export interface LodInput {
  n: number;
  zoom: number;
  bounds: [number, number, number, number];
  /** Target number of points on screen. Tuned by the capacity benchmark. */
  budget: number;
  /** Explicit user override in (0,1], or null for automatic. */
  manual: number | null;
}

export interface LodResult {
  renderFraction: number;
  radius: number;
}

/**
 * Chooses how much of the point cloud to draw.
 *
 * Because the dataset is stored pre-shuffled, drawing the first
 * `renderFraction * n` points is an unbiased uniform sample, so this is a
 * truncation rather than a filter — no per-point work, no extra buffers.
 *
 * Zooming in shrinks the viewport, so a larger fraction of the data costs
 * the same fill rate; the fraction therefore rises with zoom, and the radius
 * with it, so a dense island reads as structure when zoomed out and as
 * individual cells when zoomed in.
 *
 * There is deliberately no opacity term. Points are drawn opaque, because
 * blending is what costs four times the frame rate at a million points, and
 * varying alpha per zoom level would mean rewriting the whole colour buffer on
 * every wheel event.
 */
export function lodPolicy(input: LodInput): LodResult {
  const { n, zoom, budget, manual } = input;
  const zoomGain = Math.pow(2, Math.max(0, zoom) * 0.5);
  const fraction =
    manual !== null
      ? Math.min(1, Math.max(1e-4, manual))
      : Math.min(1, Math.max(1e-4, (budget * zoomGain) / Math.max(1, n)));

  const radius = Math.min(3.5, 0.6 + Math.max(0, zoom) * 0.28);
  return { renderFraction: fraction, radius };
}
