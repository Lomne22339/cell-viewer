import { describe, expect, it } from 'vitest';
import { buildGrid } from '@core/index/grid';
import { maskFromIndices, selectPolygon, selectRect } from '@core/select/query';
import { pointInPolygon } from '@core/select/geometry';

/** Deterministic LCG so a failure reproduces exactly. */
function randomPoints(n: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const xy = new Float32Array(n * 2);
  for (let i = 0; i < n * 2; i++) xy[i] = rnd() * 200 - 100;
  return xy;
}

function bruteForce(xy: Float32Array, n: number, poly: Float64Array): Uint32Array {
  const hits: number[] = [];
  for (let i = 0; i < n; i++) {
    if (pointInPolygon(xy[i * 2], xy[i * 2 + 1], poly)) hits.push(i);
  }
  return Uint32Array.from(hits);
}

function randomPolygon(seed: number, verts: number): Float64Array {
  let s = seed >>> 0;
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const cx = rnd() * 120 - 60;
  const cy = rnd() * 120 - 60;
  const poly = new Float64Array(verts * 2);
  for (let k = 0; k < verts; k++) {
    const a = (k / verts) * Math.PI * 2;
    const r = 8 + rnd() * 35;
    poly[k * 2] = cx + Math.cos(a) * r;
    poly[k * 2 + 1] = cy + Math.sin(a) * r;
  }
  return poly;
}

describe('grid', () => {
  it('indexes every point exactly once', () => {
    const n = 5000;
    const g = buildGrid(randomPoints(n, 42), n);
    expect(g.items.length).toBe(n);
    const seen = new Uint8Array(n);
    for (const idx of g.items) seen[idx] = 1;
    expect(seen.every(v => v === 1)).toBe(true);
  });

  it('produces bins sized near the target occupancy', () => {
    const n = 10000;
    const g = buildGrid(randomPoints(n, 7), n, 32);
    const occupancy = n / (g.cols * g.rows);
    expect(occupancy).toBeGreaterThan(4);
    expect(occupancy).toBeLessThan(256);
  });

  it('survives all-identical coordinates without an infinite grid', () => {
    const g = buildGrid(new Float32Array(2000).fill(3), 1000);
    expect(g.cols).toBeGreaterThanOrEqual(1);
    expect(g.items.length).toBe(1000);
  });
});

describe('selectPolygon', () => {
  it('matches brute force exactly across many random polygons', () => {
    const n = 20000;
    const xy = randomPoints(n, 99);
    const g = buildGrid(xy, n);
    for (let trial = 0; trial < 40; trial++) {
      const poly = randomPolygon(trial + 1, 3 + (trial % 30));
      const fast = Array.from(selectPolygon(xy, n, poly, g)).sort((a, b) => a - b);
      const slow = Array.from(bruteForce(xy, n, poly)).sort((a, b) => a - b);
      expect(fast).toEqual(slow);
    }
  });

  it('matches brute force with no grid supplied', () => {
    const n = 3000;
    const xy = randomPoints(n, 5);
    const poly = randomPolygon(11, 12);
    expect(Array.from(selectPolygon(xy, n, poly))).toEqual(Array.from(bruteForce(xy, n, poly)));
  });

  it('returns empty for a polygon outside the data', () => {
    const n = 1000;
    const xy = randomPoints(n, 3);
    const far = Float64Array.from([1000, 1000, 1010, 1000, 1010, 1010, 1000, 1010]);
    expect(selectPolygon(xy, n, far, buildGrid(xy, n)).length).toBe(0);
  });

  it('returns everything for a polygon covering the data', () => {
    const n = 1000;
    const xy = randomPoints(n, 3);
    const all = Float64Array.from([-500, -500, 500, -500, 500, 500, -500, 500]);
    expect(selectPolygon(xy, n, all, buildGrid(xy, n)).length).toBe(n);
  });

  it('only considers the first `count` points, ignoring the unloaded tail', () => {
    const n = 1000;
    const xy = randomPoints(n, 3);
    const all = Float64Array.from([-500, -500, 500, -500, 500, 500, -500, 500]);
    expect(selectPolygon(xy, 250, all).length).toBe(250);
    expect(selectPolygon(xy, 250, all, buildGrid(xy, n)).length).toBe(250);
  });
});

describe('selectRect', () => {
  it('matches an explicit filter', () => {
    const n = 5000;
    const xy = randomPoints(n, 21);
    const rect: [number, number, number, number] = [-20, -10, 30, 40];
    const got = Array.from(selectRect(xy, n, rect, buildGrid(xy, n))).sort((a, b) => a - b);
    const want: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = xy[i * 2];
      const y = xy[i * 2 + 1];
      if (x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3]) want.push(i);
    }
    expect(got).toEqual(want);
  });

  it('normalises a rectangle dragged right-to-left / bottom-to-top', () => {
    const n = 2000;
    const xy = randomPoints(n, 4);
    const g = buildGrid(xy, n);
    const a = Array.from(selectRect(xy, n, [30, 40, -20, -10], g)).sort((p, q) => p - q);
    const b = Array.from(selectRect(xy, n, [-20, -10, 30, 40], g)).sort((p, q) => p - q);
    expect(a).toEqual(b);
  });
});

describe('maskFromIndices', () => {
  it('sets exactly the selected positions', () => {
    expect(Array.from(maskFromIndices(Uint32Array.from([1, 4]), 6))).toEqual([0, 1, 0, 0, 1, 0]);
  });
});

describe('selection latency', () => {
  it('answers a 1M-point lasso in well under a second', () => {
    const n = 1_000_000;
    const xy = randomPoints(n, 1234);
    const t0 = performance.now();
    const g = buildGrid(xy, n);
    const built = performance.now() - t0;
    const poly = randomPolygon(3, 60);
    const t1 = performance.now();
    const hits = selectPolygon(xy, n, poly, g);
    const queried = performance.now() - t1;
    console.log(`[bench] 1M grid build ${built.toFixed(1)}ms, lasso ${queried.toFixed(2)}ms, ${hits.length} hits`);
    // Generous bounds: this guards against an accidental O(n * verts) path,
    // not against a specific machine's speed.
    expect(built).toBeLessThan(2000);
    expect(queried).toBeLessThan(500);
    expect(hits.length).toBeGreaterThan(0);
  });
});
