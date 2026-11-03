import type { UniformGrid } from '../index/grid';
import { normalizeRect, pointInPolygon, polygonBounds, type Polygon } from './geometry';

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

/** Up to `k` cells within `radius` of `(x, y)`, nearest first; ties break by index. */
export function nearestPoints(
  xy: Float32Array,
  count: number,
  x: number,
  y: number,
  radius: number,
  k: number,
  grid?: UniformGrid
): Uint32Array {
  if (!(radius > 0) || k <= 0 || count <= 0) return new Uint32Array(0);
  const r2 = radius * radius;
  const idx: number[] = [];
  const dist: number[] = [];
  const consider = (i: number): void => {
    const dx = xy[i * 2] - x;
    const dy = xy[i * 2 + 1] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= r2) {
      idx.push(i);
      dist.push(d2);
    }
  };

  if (!grid) {
    for (let i = 0; i < count; i++) consider(i);
  } else {
    const { c0, c1, r0, r1 } = grid.binRange([x - radius, y - radius, x + radius, y + radius]);
    const { cols, starts, items } = grid;
    for (let r = r0; r <= r1; r++) {
      const rowBase = r * cols;
      for (let c = c0; c <= c1; c++) {
        const b = rowBase + c;
        const end = starts[b + 1];
        for (let s = starts[b]; s < end; s++) {
          const i = items[s];
          if (i < count) consider(i);
        }
      }
    }
  }

  const order = idx.map((_, j) => j);
  order.sort((a, b) => dist[a] - dist[b] || idx[a] - idx[b]);
  const take = Math.min(k, order.length);
  const out = new Uint32Array(take);
  for (let j = 0; j < take; j++) out[j] = idx[order[j]];
  return out;
}

export function maskFromIndices(indices: Uint32Array, n: number): Uint8Array {
  const mask = new Uint8Array(n);
  for (let i = 0; i < indices.length; i++) mask[indices[i]] = 1;
  return mask;
}
