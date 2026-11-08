/** Flat `[x0,y0,x1,y1,...]`, implicitly closed. */
export type Polygon = Float64Array;

/**
 * Crossing-number point-in-polygon.
 *
 * The `(yi > py) !== (yj > py)` guard is what makes vertices lying exactly
 * on the test ray count once rather than twice; the naive `>=` form
 * double-counts them and produces holes along horizontal edges. Points on a
 * boundary are classified consistently but arbitrarily, which is fine for a
 * hand-drawn lasso.
 */
export function pointInPolygon(px: number, py: number, poly: Polygon): boolean {
  const v = poly.length / 2;
  if (v < 3) return false;
  let inside = false;
  for (let i = 0, j = v - 1; i < v; j = i++) {
    const xi = poly[i * 2];
    const yi = poly[i * 2 + 1];
    const xj = poly[j * 2];
    const yj = poly[j * 2 + 1];
    if ((yi > py) !== (yj > py)) {
      const t = (py - yi) / (yj - yi);
      if (px < xi + t * (xj - xi)) inside = !inside;
    }
  }
  return inside;
}

export function polygonBounds(poly: Polygon): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    const x = poly[i];
    const y = poly[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

export function normalizeRect(
  r: [number, number, number, number]
): [number, number, number, number] {
  return [
    Math.min(r[0], r[2]),
    Math.min(r[1], r[3]),
    Math.max(r[0], r[2]),
    Math.max(r[1], r[3])
  ];
}

/**
 * Ramer–Douglas–Peucker.
 *
 * A freehand drag emits a point per pointer event, so a lasso around a
 * large region arrives with several hundred nearly collinear vertices.
 * Every one of them costs a segment test per candidate point, and candidate
 * points number in the hundreds of thousands, so simplifying the path first
 * is the difference between a 10 ms query and a 200 ms one.
 */
export function simplifyPath(points: number[], tolerancePx: number): number[] {
  const n = points.length / 2;
  if (n < 3) return points.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const tol2 = tolerancePx * tolerancePx;

  while (stack.length) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    const ax = points[first * 2];
    const ay = points[first * 2 + 1];
    const bx = points[last * 2];
    const by = points[last * 2 + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;

    let worst = -1;
    let worstDist = 0;
    for (let i = first + 1; i < last; i++) {
      const px = points[i * 2];
      const py = points[i * 2 + 1];
      let d2: number;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
      if (d2 > worstDist) {
        worstDist = d2;
        worst = i;
      }
    }
    if (worstDist > tol2 && worst > 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
  return out;
}
