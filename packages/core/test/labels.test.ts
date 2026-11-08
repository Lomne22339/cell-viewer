import { describe, expect, it } from 'vitest';
import { labelCandidates, placeLabels, type LabelPlacement } from '@core/graph/labels';

type Box = [number, number, number, number];
type Disc = [number, number, number];

function boxOf(anchor: readonly [number, number], size: readonly [number, number], dx: number, dy: number): Box {
  const cx = anchor[0] + dx;
  const cy = anchor[1] + dy;
  return [cx - size[0] / 2, cy - size[1] / 2, cx + size[0] / 2, cy + size[1] / 2];
}

const overlaps = (a: Box, b: Box): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

const covers = (b: Box, [x, y, r]: Disc): boolean => {
  const dx = Math.max(b[0] - x, 0, x - b[2]);
  const dy = Math.max(b[1] - y, 0, y - b[3]);
  return dx * dx + dy * dy < r * r;
};

function randomLabels(seed: number, n: number, spread: number) {
  let s = seed >>> 0;
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const anchors: [number, number][] = Array.from({ length: n }, () => [rnd() * spread, rnd() * spread]);
  const sizes: [number, number][] = Array.from({ length: n }, (_, i) => [i < 9 ? 13 : 20, 13]);
  const radii = Array.from({ length: n }, () => 2 + rnd() * 6);
  const discs: Disc[] = [[rnd() * spread, rnd() * spread, 12]];
  const bx = rnd() * spread;
  const by = rnd() * spread;
  const blocked: Box[] = [[bx, by, bx + spread / 3, by + spread / 4]];
  return { anchors, sizes, radii, discs, blocked };
}

describe('rank label placement', () => {
  it('puts a lone label up and to the right of its anchor', () => {
    expect(placeLabels([[100, 100]], [[13, 13]], 4.5)).toEqual([{ visible: true, dx: 11, dy: -11 }]);
  });

  it('keeps the preferred corner for labels that are far apart', () => {
    const out = placeLabels([[0, 0], [100, 0], [0, 100]], [[13, 13], [13, 13], [20, 13]], 4.5);
    expect(out.map(p => [p.visible, p.dx > 0, p.dy < 0])).toEqual([[true, true, true], [true, true, true], [true, true, true]]);
  });

  it('moves a label that would cover an earlier one to the next free side', () => {
    const [a, b] = placeLabels([[50, 50], [50, 50]], [[13, 13], [13, 13]], 4.5);
    expect(a).toEqual({ visible: true, dx: 11, dy: -11 });
    expect(b).toEqual({ visible: true, dx: -11, dy: -11 });
  });

  it('hides a label only when every side is taken', () => {
    const anchors: [number, number][] = Array.from({ length: 12 }, () => [50, 50]);
    const sizes: [number, number][] = anchors.map(() => [13, 13]);
    const out = placeLabels(anchors, sizes, 4.5);
    expect(out[0].visible).toBe(true);
    expect(out.some(p => !p.visible)).toBe(true);
  });

  it("steers a label off another node's marker when a free side exists", () => {
    // Node 1's marker sits under the spot node 0's label would take first.
    const out = placeLabels([[50, 50], [66, 34]], [[13, 13], [13, 13]], 4.5, { radii: [3, 5] });
    expect(out[0]).toEqual({ visible: true, dx: -11, dy: -11 });
    expect(out[1]).toEqual({ visible: true, dx: 11, dy: -11 });
  });

  it('never puts a label where a card would hide it', () => {
    // A card over the up-right and down-right sides of the node.
    const out = placeLabels([[50, 50]], [[13, 13]], 4.5, { blocked: [[52, 30, 200, 200]] });
    expect(out).toEqual([{ visible: true, dx: -11, dy: -11 }]);
    const covered = placeLabels([[50, 50]], [[13, 13]], 4.5, { blocked: [[0, 0, 100, 100]] });
    expect(covered).toEqual([{ visible: false, dx: 0, dy: 0 }]);
  });

  it('never hides a label to keep a marker clear', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { anchors, sizes, radii, discs, blocked } = randomLabels(seed, 20, 40);
      const plain = placeLabels(anchors, sizes, 4.5, { blocked }).map(p => p.visible);
      const avoiding = placeLabels(anchors, sizes, 4.5, { radii, discs, blocked }).map(p => p.visible);
      expect(avoiding, `seed ${seed}`).toEqual(plain);
    }
  });

  it('never avoids its own marker, and covers a disc rather than drop the label', () => {
    const own = placeLabels([[50, 50]], [[13, 13]], 4.5, { radii: [8] });
    expect(own).toEqual([{ visible: true, dx: 11, dy: -11 }]);
    const ringed = placeLabels([[50, 50]], [[13, 13]], 4.5, { discs: [[50, 50, 40]] });
    expect(ringed).toEqual([{ visible: true, dx: 11, dy: -11 }]);
  });

  it('is exactly the two-pass rule: earlier ranks win, then labels leave markers where they can, and no two drawn labels overlap', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { anchors, sizes, radii, discs, blocked } = randomLabels(seed, 20, seed % 2 === 0 ? 40 : 200);
      const avoid = seed % 3 === 0 ? undefined : { radii, discs, blocked };
      const out: LabelPlacement[] = placeLabels(anchors, sizes, 4.5, avoid);

      // Reference, written independently: every label's box, or null when hidden.
      const hidden = (b: Box): boolean => (avoid ? blocked.some(k => overlaps(b, k)) : false);
      const options = anchors.map((a, i) =>
        labelCandidates(sizes[i], 4.5)
          .map(([dx, dy]) => ({ dx, dy, box: boxOf(a, sizes[i], dx, dy) }))
          .filter(o => !hidden(o.box))
      );
      const chosen: ({ dx: number; dy: number; box: Box } | null)[] = [];
      for (let i = 0; i < anchors.length; i++) {
        chosen.push(options[i].find(o => chosen.every(c => !c || !overlaps(o.box, c.box))) ?? null);
      }
      if (avoid) {
        const others = (i: number): Disc[] => [
          ...anchors.flatMap(([x, y], j): Disc[] => (j === i ? [] : [[x, y, radii[j]]])),
          ...discs
        ];
        for (let i = 0; i < anchors.length; i++) {
          const c = chosen[i];
          if (!c || others(i).every(d => !covers(c.box, d))) continue;
          const better = options[i].find(
            o => chosen.every((d, j) => j === i || !d || !overlaps(o.box, d.box)) && others(i).every(d => !covers(o.box, d))
          );
          if (better) chosen[i] = better;
        }
      }

      for (let i = 0; i < anchors.length; i++) {
        const c = chosen[i];
        expect(out[i], `seed ${seed} label ${i}`).toEqual(c ? { visible: true, dx: c.dx, dy: c.dy } : { visible: false, dx: 0, dy: 0 });
      }
      const kept = chosen.flatMap(c => (c ? [c.box] : []));
      for (let i = 0; i < kept.length; i++) {
        for (let j = i + 1; j < kept.length; j++) expect(overlaps(kept[i], kept[j])).toBe(false);
      }
    }
  });
});
