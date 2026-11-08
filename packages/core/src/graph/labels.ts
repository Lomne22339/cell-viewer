/**
 * Placement of the rank numbers drawn beside highlighted trajectory nodes.
 *
 * At the default zoom the closest nodes sit two or three pixels apart, so
 * labels all drawn up and to the right pile on top of each other and none of
 * them can be read. Each label instead tries the eight sides of its node in a
 * fixed order and takes the first that covers no label already placed, then
 * moves off any other node's marker if a free side allows; a
 * label with no free side is left out (the node card still lists every rank,
 * and zooming in spreads the nodes until the labels fit). Labels are placed
 * in rank order, so the closest neighbours always win.
 *
 * Everything is in screen pixels. Highlights hold at most a few dozen nodes,
 * so plain arrays and an all-pairs check are fine.
 */

export interface LabelPlacement {
  visible: boolean;
  /** Offset of the label centre from its anchor, in pixels (y down). */
  dx: number;
  dy: number;
}

/**
 * Label-centre offsets to try, in order: the four corners (up-right first, as
 * a lone label has always been drawn), then the four sides. `gap` is the
 * clearance between the anchor and the nearest edge of the label.
 */
export function labelCandidates(size: readonly [number, number], gap: number): [number, number][] {
  const x = gap + size[0] / 2;
  const y = gap + size[1] / 2;
  return [[x, -y], [-x, -y], [x, y], [-x, y], [x, 0], [-x, 0], [0, -y], [0, y]];
}

/** What a label should keep clear of, besides other labels. */
export interface LabelAvoid {
  /** Radius of the marker drawn at each anchor. A label never avoids its own. */
  radii?: readonly number[];
  /** Further discs to keep clear, as `[x, y, radius]` (the clicked node's ring). */
  discs?: readonly (readonly [number, number, number])[];
  /**
   * Areas where a label would not be seen, as `[x0, y0, x1, y1]` (a card laid
   * over the plot). A label is never placed there, in either pass.
   */
  blocked?: readonly (readonly [number, number, number, number])[];
}

/** Whether a box and a disc overlap (touching is not overlapping). */
function boxHitsDisc(x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, r: number): boolean {
  const dx = Math.max(x0 - cx, 0, cx - x1);
  const dy = Math.max(y0 - cy, 0, cy - y1);
  return dx * dx + dy * dy < r * r;
}

/**
 * Placement in two passes. `anchors[i]` is label i's node on screen and
 * `sizes[i]` its width and height; the result says whether label i is drawn
 * and where. No two drawn labels overlap (touching edges is allowed).
 *
 * The first pass decides which labels are drawn: in input order, each takes
 * the first side that covers no label already placed and is not blocked from
 * view. Marker avoidance plays
 * no part there, because steering one number off a marker can take the only
 * free side of a later one, and a number over a marker reads better than no
 * number. The second pass, again in input order, moves a drawn label that
 * covers another node's marker or an extra disc to the first side that
 * covers neither those nor any other drawn label, when there is one.
 */
export function placeLabels(
  anchors: readonly (readonly [number, number])[],
  sizes: readonly (readonly [number, number])[],
  gap: number,
  avoid: LabelAvoid = {}
): LabelPlacement[] {
  const n = anchors.length;
  const radii = avoid.radii;
  const discs = avoid.discs ?? [];
  const blocked = avoid.blocked ?? [];
  const candidates = sizes.map(s => labelCandidates(s, gap));
  // Drawn boxes as flat [x0, y0, x1, y1] runs, indexed by label; NaN when hidden.
  const boxes = new Float64Array(4 * n).fill(NaN);
  const out: LabelPlacement[] = [];

  const boxAt = (i: number, dx: number, dy: number): [number, number, number, number] => {
    const x0 = anchors[i][0] + dx - sizes[i][0] / 2;
    const y0 = anchors[i][1] + dy - sizes[i][1] / 2;
    return [x0, y0, x0 + sizes[i][0], y0 + sizes[i][1]];
  };
  // Whether a box for label i is clear of every other drawn label (NaN never
  // overlaps) and of every blocked area.
  const clearOfLabels = (i: number, [x0, y0, x1, y1]: [number, number, number, number]): boolean => {
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const k = 4 * j;
      if (x0 < boxes[k + 2] && boxes[k] < x1 && y0 < boxes[k + 3] && boxes[k + 1] < y1) return false;
    }
    for (const [bx0, by0, bx1, by1] of blocked) if (x0 < bx1 && bx0 < x1 && y0 < by1 && by0 < y1) return false;
    return true;
  };
  const clearOfDiscs = (i: number, [x0, y0, x1, y1]: [number, number, number, number]): boolean => {
    if (radii) {
      for (let j = 0; j < n; j++) {
        if (j !== i && boxHitsDisc(x0, y0, x1, y1, anchors[j][0], anchors[j][1], radii[j])) return false;
      }
    }
    for (const [cx, cy, r] of discs) if (boxHitsDisc(x0, y0, x1, y1, cx, cy, r)) return false;
    return true;
  };

  for (let i = 0; i < n; i++) {
    let placed: LabelPlacement = { visible: false, dx: 0, dy: 0 };
    for (const [dx, dy] of candidates[i]) {
      const b = boxAt(i, dx, dy);
      if (clearOfLabels(i, b)) {
        boxes.set(b, 4 * i);
        placed = { visible: true, dx, dy };
        break;
      }
    }
    out.push(placed);
  }

  if (radii || discs.length > 0) {
    for (let i = 0; i < n; i++) {
      if (!out[i].visible || clearOfDiscs(i, boxAt(i, out[i].dx, out[i].dy))) continue;
      for (const [dx, dy] of candidates[i]) {
        const b = boxAt(i, dx, dy);
        if (clearOfLabels(i, b) && clearOfDiscs(i, b)) {
          boxes.set(b, 4 * i);
          out[i] = { visible: true, dx, dy };
          break;
        }
      }
    }
  }
  return out;
}
