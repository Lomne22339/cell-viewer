export interface LodInput {
  n: number;
  zoom: number;
  bounds: [number, number, number, number];
  budget: number;
  manual: number | null;
}

export interface LodResult {
  renderFraction: number;
  radius: number;
}

/** How much of the pre-shuffled cloud to draw (a prefix is a uniform sample); points stay opaque. */
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
