/**
 * Geometry for the foreground inset: a magnified view of one region of the
 * embedding, placed over the plot, with the region marked on the main view
 * and joined to the inset by two connector lines — the matplotlib
 * `zoomed_inset_axes` + `mark_inset` convention for figures that need two
 * scales at once.
 *
 * World maths (fitting, regions) is independent of which way the y axis
 * points, so it lives here; projecting to screen pixels is the renderer's job.
 */

/** `[minX, minY, maxX, maxY]` in world units. */
export type Bounds = [number, number, number, number];

/** Screen-space rectangle in CSS pixels, origin top-left. */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OrthoFit {
  target: [number, number];
  zoom: number;
}

/**
 * Orthographic view state that fits `bounds` into a `width × height` viewport,
 * with `pad` (> 1 leaves a margin). One world unit spans 2^zoom pixels.
 */
export function fitBounds(bounds: Bounds, width: number, height: number, pad = 1): OrthoFit {
  const [x0, y0, x1, y1] = bounds;
  const w = Math.max((x1 - x0) * pad, 1e-9);
  const h = Math.max((y1 - y0) * pad, 1e-9);
  const zoom = Math.log2(Math.min(Math.max(width, 1) / w, Math.max(height, 1) / h));
  return { target: [(x0 + x1) / 2, (y0 + y1) / 2], zoom: Number.isFinite(zoom) ? zoom : 0 };
}

/** World bounds visible in a `width × height` viewport centred on `target` at `zoom`. */
export function visibleBounds(target: [number, number], zoom: number, width: number, height: number): Bounds {
  const scale = Math.pow(2, zoom);
  const hw = width / 2 / scale;
  const hh = height / 2 / scale;
  return [target[0] - hw, target[1] - hh, target[0] + hw, target[1] + hh];
}

/**
 * A region whose aspect matches the inset panel, so the marked rectangle on
 * the plot is exactly what the inset shows — no letterboxing to explain.
 */
export function regionAround(center: [number, number], worldWidth: number, aspect: number): Bounds {
  const w = Math.max(worldWidth, 1e-9);
  const h = w * (aspect > 0 && Number.isFinite(aspect) ? aspect : 1);
  return [center[0] - w / 2, center[1] - h / 2, center[0] + w / 2, center[1] + h / 2];
}

/** How much larger the inset draws the region than the main view does. */
export function magnification(mainZoom: number, insetZoom: number): number {
  return Math.pow(2, insetZoom - mainZoom);
}

/** Keeps a rectangle inside a container, shrinking it only if it cannot fit. */
export function clampRect(r: ScreenRect, cw: number, ch: number, minW = 1, minH = 1): ScreenRect {
  const w = Math.max(minW, Math.min(r.w, cw));
  const h = Math.max(minH, Math.min(r.h, ch));
  return {
    x: Math.min(Math.max(0, r.x), Math.max(0, cw - w)),
    y: Math.min(Math.max(0, r.y), Math.max(0, ch - h)),
    w,
    h
  };
}

export function rectsIntersect(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

type Pt = [number, number];

function corners(r: ScreenRect): Pt[] {
  return [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h]
  ];
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/**
 * The two connector lines between a marked region and its inset.
 *
 * They are the edges of the convex hull of both rectangles that bridge from
 * one to the other — the outer tangents — so they never cut through either
 * rectangle, whatever the relative placement. When a hull edge runs along a
 * side shared by both (inset level with the region), it is shortened to the
 * nearest pair of corners, which is what a figure editor would draw. Returns
 * no lines when the rectangles overlap, because no clean pair exists.
 */
export function connectorLines(region: ScreenRect, inset: ScreenRect): [Pt, Pt][] {
  if (rectsIntersect(region, inset)) return [];
  const a = corners(region);
  const b = corners(inset);
  const pts = [...a.map(p => ({ p, from: 0 })), ...b.map(p => ({ p, from: 1 }))];
  pts.sort((u, v) => u.p[0] - v.p[0] || u.p[1] - v.p[1]);

  // Andrew's monotone chain; collinear points dropped.
  const hull: typeof pts = [];
  for (const q of pts) {
    while (hull.length >= 2 && cross(hull[hull.length - 2].p, hull[hull.length - 1].p, q.p) <= 0) hull.pop();
    hull.push(q);
  }
  const lower = hull.length + 1;
  for (let i = pts.length - 2; i >= 0; i--) {
    const q = pts[i];
    while (hull.length >= lower && cross(hull[hull.length - 2].p, hull[hull.length - 1].p, q.p) <= 0) hull.pop();
    hull.push(q);
  }
  hull.pop();

  const onSegment = (p: Pt, s: Pt, e: Pt): boolean => {
    if (Math.abs(cross(s, e, p)) > 1e-9 * (1 + Math.abs(e[0] - s[0]) + Math.abs(e[1] - s[1]))) return false;
    const t = ((p[0] - s[0]) * (e[0] - s[0]) + (p[1] - s[1]) * (e[1] - s[1])) /
      Math.max(1e-12, (e[0] - s[0]) ** 2 + (e[1] - s[1]) ** 2);
    return t >= -1e-9 && t <= 1 + 1e-9;
  };
  const nearestOn = (set: Pt[], s: Pt, e: Pt, to: Pt): Pt => {
    let best = s;
    let bd = Infinity;
    for (const c of set) {
      if (!onSegment(c, s, e)) continue;
      const d = (c[0] - to[0]) ** 2 + (c[1] - to[1]) ** 2;
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  };

  const lines: [Pt, Pt][] = [];
  for (let i = 0; i < hull.length; i++) {
    const u = hull[i];
    const v = hull[(i + 1) % hull.length];
    if (u.from === v.from) continue;
    const [s, e] = u.from === 0 ? [u.p, v.p] : [v.p, u.p];
    const fromRegion = nearestOn(a, s, e, e);
    const toInset = nearestOn(b, s, e, fromRegion);
    lines.push([fromRegion, toInset]);
  }
  return lines;
}
