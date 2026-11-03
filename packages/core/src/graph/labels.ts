/** Rank-number placement beside highlighted nodes (screen pixels): first free side, in rank order. */

export interface LabelPlacement {
  visible: boolean;
  /** Offset of the label center from its anchor, in pixels (y down). */
  dx: number;
  dy: number;
}

export function labelCandidates(size: readonly [number, number], gap: number): [number, number][] {
  const x = gap + size[0] / 2;
  const y = gap + size[1] / 2;
  return [[x, -y], [-x, -y], [x, y], [-x, y], [x, 0], [-x, 0], [0, -y], [0, y]];
}

export interface LabelAvoid {
  radii?: readonly number[];
  discs?: readonly (readonly [number, number, number])[];
  blocked?: readonly (readonly [number, number, number, number])[];
}

function boxHitsDisc(x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, r: number): boolean {
  const dx = Math.max(x0 - cx, 0, cx - x1);
  const dy = Math.max(y0 - cy, 0, cy - y1);
  return dx * dx + dy * dy < r * r;
}

/** Two passes: decide which labels are drawn (ignoring markers), then move them off other markers. */
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
