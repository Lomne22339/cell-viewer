import { describe, expect, it } from 'vitest';
import { pointInPolygon, polygonBounds, simplifyPath } from '@core/select/geometry';

const square = Float64Array.from([0, 0, 10, 0, 10, 10, 0, 10]);
// A concave "C": the middle-right region is outside.
const cShape = Float64Array.from([0, 0, 10, 0, 10, 3, 4, 3, 4, 7, 10, 7, 10, 10, 0, 10]);

describe('pointInPolygon', () => {
  it('accepts interior points and rejects exterior ones', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(-1, 5, square)).toBe(false);
    expect(pointInPolygon(11, 5, square)).toBe(false);
    expect(pointInPolygon(5, 20, square)).toBe(false);
  });

  it('respects concavity', () => {
    expect(pointInPolygon(2, 5, cShape)).toBe(true);
    expect(pointInPolygon(7, 5, cShape)).toBe(false);
    expect(pointInPolygon(7, 1, cShape)).toBe(true);
  });

  it('is consistent for points on a horizontal edge (no double counting)', () => {
    expect(pointInPolygon(5, 0, square)).toBe(pointInPolygon(5, 0, square));
    expect(pointInPolygon(5, -0.001, square)).toBe(false);
    expect(pointInPolygon(5, 0.001, square)).toBe(true);
  });

  it('handles a vertex exactly on the test ray', () => {
    const tri = Float64Array.from([0, 0, 10, 5, 0, 10]);
    expect(pointInPolygon(1, 5, tri)).toBe(true);
    expect(pointInPolygon(-1, 5, tri)).toBe(false);
  });

  it('returns false for degenerate polygons', () => {
    expect(pointInPolygon(1, 1, Float64Array.from([0, 0, 1, 1]))).toBe(false);
    expect(pointInPolygon(1, 1, Float64Array.from([]))).toBe(false);
  });

  it('handles a self-intersecting lasso without throwing', () => {
    const bowtie = Float64Array.from([0, 0, 10, 10, 10, 0, 0, 10]);
    expect(() => pointInPolygon(5, 2, bowtie)).not.toThrow();
  });

  it('computes bounds', () => {
    expect(Array.from(polygonBounds(cShape))).toEqual([0, 0, 10, 10]);
  });
});

describe('simplifyPath', () => {
  it('collapses a straight run to its endpoints', () => {
    expect(simplifyPath([0, 0, 1, 0, 2, 0, 3, 0, 4, 0], 0.5)).toEqual([0, 0, 4, 0]);
  });

  it('keeps a corner', () => {
    expect(simplifyPath([0, 0, 5, 0, 5, 5], 0.5)).toEqual([0, 0, 5, 0, 5, 5]);
  });

  it('drops the jitter a pointer drag produces', () => {
    const pts: number[] = [];
    for (let i = 0; i <= 200; i++) pts.push(i, (i % 2) * 0.3);
    const out = simplifyPath(pts, 1);
    expect(out.length).toBeLessThan(20);
    expect(out.length).toBeGreaterThanOrEqual(4);
  });

  it('preserves a circle well enough to stay a closed loop', () => {
    const pts: number[] = [];
    for (let k = 0; k < 360; k++) {
      const a = (k / 360) * Math.PI * 2;
      pts.push(Math.cos(a) * 100, Math.sin(a) * 100);
    }
    const out = simplifyPath(pts, 2);
    expect(out.length / 2).toBeGreaterThan(12);
    expect(out.length / 2).toBeLessThan(180);
  });

  it('returns short inputs untouched', () => {
    expect(simplifyPath([1, 2], 5)).toEqual([1, 2]);
    expect(simplifyPath([], 5)).toEqual([]);
  });
});
