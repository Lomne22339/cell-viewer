const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * SVG path data for a curve joining two points, leaving and arriving
 * horizontally: the line from an organ on the body to its card beside it.
 * The control points sit half the horizontal distance along, so the curve
 * bends the same whichever way it runs.
 */
export function connectorPath(from: [number, number], to: [number, number]): string {
  const [x0, y0] = from;
  const [x1, y1] = to;
  const reach = (x1 - x0) / 2;
  return `M${r2(x0)} ${r2(y0)} C${r2(x0 + reach)} ${r2(y0)} ${r2(x1 - reach)} ${r2(y1)} ${r2(x1)} ${r2(y1)}`;
}
