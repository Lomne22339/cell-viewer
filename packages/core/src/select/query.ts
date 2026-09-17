import type { UniformGrid } from '../index/grid';
import { normalizeRect, pointInPolygon, polygonBounds, type Polygon } from './geometry';

/**
 * Region query, grid-accelerated when an index is supplied.
 *
 * The grid narrows candidates to bins overlapping the polygon's bounding
 * box; every surviving candidate still gets a full point-in-polygon test,
 * so the result is identical to brute force rather than approximate. That
 * equality is asserted by property tests, because an index that silently
 * drops points is worse than no index.
 */
export function selectPolygon(
  xy: Float32Array,
  count: number,
  poly: Polygon,
  grid?: UniformGrid
): Uint32Array {
  if (poly.length < 6) return new Uint32Array(0);
  const bounds = polygonBounds(poly);
  const out = new Uint32Array(count);
  let k = 0;

  if (!grid) {
    for (let i = 0; i < count; i++) {
      const x = xy[i * 2];
      const y = xy[i * 2 + 1];
      if (x < bounds[0] || x > bounds[2] || y < bounds[1] || y > bounds[3]) continue;
      if (pointInPolygon(x, y, poly)) out[k++] = i;
    }
    return out.slice(0, k);
  }

  const { c0, c1, r0, r1 } = grid.binRange(bounds);
  const { cols, starts, items } = grid;
  for (let r = r0; r <= r1; r++) {
    const rowBase = r * cols;
    for (let c = c0; c <= c1; c++) {
      const b = rowBase + c;
      const end = starts[b + 1];
      for (let s = starts[b]; s < end; s++) {
        const i = items[s];
        // The grid may hold points beyond the loaded prefix; skip them.
        if (i >= count) continue;
        const x = xy[i * 2];
        const y = xy[i * 2 + 1];
        if (x < bounds[0] || x > bounds[2] || y < bounds[1] || y > bounds[3]) continue;
        if (pointInPolygon(x, y, poly)) out[k++] = i;
      }
    }
  }
  const res = out.slice(0, k);
  res.sort();
  return res;
}

export function selectRect(
  xy: Float32Array,
  count: number,
  rect: [number, number, number, number],
  grid?: UniformGrid
): Uint32Array {
  const [x0, y0, x1, y1] = normalizeRect(rect);
  const out = new Uint32Array(count);
  let k = 0;

  if (!grid) {
    for (let i = 0; i < count; i++) {
      const x = xy[i * 2];
      const y = xy[i * 2 + 1];
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out[k++] = i;
    }
    return out.slice(0, k);
  }

  const { c0, c1, r0, r1 } = grid.binRange([x0, y0, x1, y1]);
  const { cols, starts, items } = grid;
  for (let r = r0; r <= r1; r++) {
    const rowBase = r * cols;
    for (let c = c0; c <= c1; c++) {
      const b = rowBase + c;
      const end = starts[b + 1];
      for (let s = starts[b]; s < end; s++) {
        const i = items[s];
        if (i >= count) continue;
        const x = xy[i * 2];
        const y = xy[i * 2 + 1];
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out[k++] = i;
      }
    }
  }
  const res = out.slice(0, k);
  res.sort();
  return res;
}

export function maskFromIndices(indices: Uint32Array, n: number): Uint8Array {
  const mask = new Uint8Array(n);
  for (let i = 0; i < indices.length; i++) mask[indices[i]] = 1;
  return mask;
}
