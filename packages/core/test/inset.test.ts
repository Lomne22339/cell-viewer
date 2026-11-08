import { describe, expect, it } from 'vitest';
import {
  clampRect,
  connectorLines,
  fitBounds,
  magnification,
  rectsIntersect,
  regionAround,
  visibleBounds,
  type ScreenRect
} from '@core/inset/geometry';

describe('inset view maths', () => {
  it('fits bounds into a viewport and round-trips through visibleBounds', () => {
    const fit = fitBounds([0, 0, 100, 50], 400, 200);
    expect(fit.target).toEqual([50, 25]);
    expect(fit.zoom).toBeCloseTo(2); // 4 px per unit
    const vis = visibleBounds(fit.target, fit.zoom, 400, 200);
    vis.forEach((v, i) => expect(v).toBeCloseTo([0, 0, 100, 50][i]));
  });

  it('letterboxes the tighter axis and honours padding', () => {
    const fit = fitBounds([0, 0, 100, 100], 400, 200, 1.25);
    expect(fit.zoom).toBeCloseTo(Math.log2(200 / 125));
  });

  it('survives degenerate bounds', () => {
    expect(Number.isFinite(fitBounds([5, 5, 5, 5], 100, 100).zoom)).toBe(true);
  });

  it('builds a region with the inset aspect and reports magnification', () => {
    expect(regionAround([10, 20], 8, 0.5)).toEqual([6, 18, 14, 22]);
    expect(regionAround([0, 0], 4, NaN)).toEqual([-2, -2, 2, 2]);
    expect(magnification(1, 3)).toBe(4);
  });

  it('clamps a dragged panel inside its container', () => {
    expect(clampRect({ x: -20, y: 500, w: 100, h: 80 }, 400, 300)).toEqual({ x: 0, y: 220, w: 100, h: 80 });
    expect(clampRect({ x: 10, y: 10, w: 900, h: 80 }, 400, 300, 120, 90)).toEqual({ x: 0, y: 10, w: 400, h: 90 });
  });
});

/** True when segment p-q passes through the interior of r (not just a corner). */
function crossesInterior([p, q]: [[number, number], [number, number]], r: ScreenRect): boolean {
  for (let t = 0.02; t < 1; t += 0.02) {
    const x = p[0] + (q[0] - p[0]) * t;
    const y = p[1] + (q[1] - p[1]) * t;
    if (x > r.x + 1e-6 && x < r.x + r.w - 1e-6 && y > r.y + 1e-6 && y < r.y + r.h - 1e-6) return true;
  }
  return false;
}

describe('connectorLines (mark_inset)', () => {
  const region: ScreenRect = { x: 100, y: 300, w: 60, h: 40 };

  it('joins the facing corners when the inset sits level to the right', () => {
    const inset: ScreenRect = { x: 400, y: 300, w: 240, h: 40 };
    const lines = connectorLines(region, inset);
    expect(lines).toHaveLength(2);
    const ends = lines.map(([a, b]) => `${a.join(',')}->${b.join(',')}`).sort();
    expect(ends).toEqual(['160,300->400,300', '160,340->400,340']);
  });

  it('draws the outer tangents for a diagonal placement', () => {
    const inset: ScreenRect = { x: 500, y: 20, w: 200, h: 140 };
    const lines = connectorLines(region, inset);
    expect(lines).toHaveLength(2);
    // Region bottom-left of the inset: the cone runs from its top-left and
    // bottom-right corners to the inset's matching corners.
    const ends = lines.map(([a, b]) => `${a.join(',')}->${b.join(',')}`).sort();
    expect(ends).toEqual(['100,300->500,20', '160,340->700,160']);
  });

  it('never cuts through either rectangle, for any placement', () => {
    let s = 3;
    const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let trial = 0; trial < 300; trial++) {
      const r: ScreenRect = { x: rnd() * 800, y: rnd() * 600, w: 10 + rnd() * 120, h: 10 + rnd() * 120 };
      const i: ScreenRect = { x: rnd() * 800, y: rnd() * 600, w: 40 + rnd() * 260, h: 40 + rnd() * 200 };
      const lines = connectorLines(r, i);
      if (rectsIntersect(r, i)) {
        expect(lines).toEqual([]);
        continue;
      }
      expect(lines.length).toBe(2);
      for (const line of lines) {
        expect(crossesInterior(line, r)).toBe(false);
        expect(crossesInterior(line, i)).toBe(false);
      }
    }
  });

  it('draws nothing when the inset overlaps its region', () => {
    expect(connectorLines(region, { x: 120, y: 310, w: 100, h: 100 })).toEqual([]);
  });
});
