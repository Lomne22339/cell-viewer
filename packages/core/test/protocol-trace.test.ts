import { describe, expect, it } from 'vitest';
import { synthesizeProtocol } from '@core/protocol/synthetic';
import {
  branchesAlong,
  chainTo,
  childrenOf,
  heaviestLeaf,
  milestoneAtTime,
  milestoneWeights,
  nodeMilestones,
  stageTime,
  subtreeWeights,
  terminalsUnder
} from '@core/protocol/trace';
import { nearestNodeCounts } from '@core/protocol/cells';
import { handGraph, randomGraph, rng, STAGES } from './helpers/trees';

const opts = { datasetId: 't', stageLabels: STAGES };
// Milestones of the hand graph: 0 stem, 1 fate, 2 progenitor, 3 fate, 4 fate.
const hand = synthesizeProtocol(handGraph(), opts);

describe('childrenOf and terminalsUnder', () => {
  it('lists children in id order', () => {
    expect(childrenOf(hand)).toEqual([[1, 2], [], [3, 4], [], []]);
  });

  it('finds the fates below a milestone', () => {
    expect(terminalsUnder(hand, 0)).toEqual([1, 3, 4]);
    expect(terminalsUnder(hand, 2)).toEqual([3, 4]);
    expect(terminalsUnder(hand, 3)).toEqual([3]);
  });
});

describe('chainTo: the way back to the stem cell', () => {
  it('runs from the stem to the milestone, in order', () => {
    expect(chainTo(hand, 3)).toEqual([0, 2, 3]);
    expect(chainTo(hand, 1)).toEqual([0, 1]);
    expect(chainTo(hand, 0)).toEqual([0]);
  });

  it('is empty for an id that is not a milestone', () => {
    expect(chainTo(hand, -1)).toEqual([]);
    expect(chainTo(hand, 5)).toEqual([]);
    expect(chainTo(hand, 1.5)).toEqual([]);
  });

  it.each(Array.from({ length: 30 }, (_, i) => i + 1))('equals following parents by hand, random tree %i', seed => {
    const tree = synthesizeProtocol(randomGraph(seed, 10 + seed * 4), opts);
    for (const m of tree.milestones) {
      const brute: number[] = [];
      for (let at: number | null = m.id; at !== null; at = tree.milestones[at].parent) brute.unshift(at);
      expect(chainTo(tree, m.id)).toEqual(brute);
      expect(chainTo(tree, m.id)[0]).toBe(0);
    }
  });
});

describe('nodeMilestones', () => {
  it('maps every graph node to its milestone, and unreachable nodes to -1', () => {
    const g = handGraph();
    g.nodes.push([50, 50]);
    const tree = synthesizeProtocol(g, opts);
    const map = nodeMilestones(tree, g.nodes.length);
    expect(Array.from(map)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 3, 4, -1]);
  });
});

describe('branchesAlong: where the path forks and what it gives up', () => {
  it('names the lineage taken, the ones skipped and the fates ruled out', () => {
    expect(branchesAlong(hand, [0, 2, 3])).toEqual([
      { at: 0, taken: 2, alternatives: [1], excludedFates: [1] },
      { at: 2, taken: 3, alternatives: [4], excludedFates: [4] }
    ]);
  });

  it('lists the options ahead when the path stops at a fork', () => {
    expect(branchesAlong(hand, [0, 2])).toEqual([
      { at: 0, taken: 2, alternatives: [1], excludedFates: [1] },
      { at: 2, taken: null, alternatives: [3, 4], excludedFates: [] }
    ]);
  });

  it('is empty for a path that never forks', () => {
    expect(branchesAlong(hand, [])).toEqual([]);
    expect(branchesAlong(hand, [0, 1])).toEqual([{ at: 0, taken: 1, alternatives: [2], excludedFates: [3, 4] }]);
    expect(branchesAlong(hand, [1])).toEqual([]);
  });

  it.each(Array.from({ length: 20 }, (_, i) => i + 1))('excluded fates equal a brute-force search, random tree %i', seed => {
    const tree = synthesizeProtocol(randomGraph(seed, 30 + seed * 5), opts);
    const kids = childrenOf(tree);
    for (const leaf of tree.milestones.filter(m => m.kind === 'terminal')) {
      const chain = chainTo(tree, leaf.id);
      for (const b of branchesAlong(tree, chain)) {
        expect(b.taken).not.toBeNull();
        expect(kids[b.at].length).toBeGreaterThan(1);
        const siblings = kids[b.at].filter(c => c !== b.taken);
        expect(b.alternatives).toEqual(siblings);
        const brute: number[] = [];
        const walk = (id: number): void => {
          if (kids[id].length === 0) brute.push(id);
          for (const c of kids[id]) walk(c);
        };
        for (const s of siblings) walk(s);
        expect(b.excludedFates).toEqual(brute.sort((a, b2) => a - b2));
      }
    }
  });
});

describe('milestoneAtTime', () => {
  const chain = [0, 2, 3];

  it('takes the first milestone on the path that has not ended by that time', () => {
    const e = hand.milestones.map(m => m.ptEnd);
    expect(milestoneAtTime(hand, chain, 0)).toBe(0);
    expect(milestoneAtTime(hand, chain, e[0])).toBe(0);
    expect(milestoneAtTime(hand, chain, (e[0] + e[2]) / 2)).toBe(2);
    expect(milestoneAtTime(hand, chain, e[3])).toBe(3);
  });

  it('clamps to the ends of the path', () => {
    expect(milestoneAtTime(hand, chain, -1)).toBe(0);
    expect(milestoneAtTime(hand, chain, 5)).toBe(3);
  });

  it('is null for an empty path', () => {
    expect(milestoneAtTime(hand, [], 0.5)).toBeNull();
  });
});

describe('stageTime', () => {
  it('is the middle of the stage band', () => {
    expect(stageTime(0, 6)).toBeCloseTo(1 / 12, 12);
    expect(stageTime(5, 6)).toBeCloseTo(11 / 12, 12);
    expect(stageTime(0, 1)).toBe(0.5);
  });
});

describe('weights and the heaviest lineage', () => {
  // One cell per graph node, except two crowded leaves.
  const counts = new Float64Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);

  it('sums cells per milestone and per subtree', () => {
    const map = nodeMilestones(hand, 10);
    const own = milestoneWeights(hand, map, counts);
    expect(own).toEqual([3, 3, 2, 1, 1]);
    expect(subtreeWeights(hand, own)).toEqual([10, 3, 4, 1, 1]);
  });

  it('descends to the heavier child, and from a fate stays put', () => {
    const own = [3, 3, 2, 1, 1];
    const sub = subtreeWeights(hand, own);
    expect(heaviestLeaf(hand, 0, sub)).toBe(3); // 2's subtree (4) beats 1 (3); then 3 ties 4 and the lower id wins
    expect(heaviestLeaf(hand, 2, sub)).toBe(3);
    expect(heaviestLeaf(hand, 4, sub)).toBe(4);
  });

  it('picks the child with the most cells even when it has the higher id', () => {
    const sub = subtreeWeights(hand, [0, 0, 0, 1, 9]);
    expect(heaviestLeaf(hand, 0, sub)).toBe(4);
  });

  it('breaks ties toward the lower id, so the default is stable', () => {
    const sub = subtreeWeights(hand, [0, 0, 0, 0, 0]);
    expect(heaviestLeaf(hand, 0, sub)).toBe(1);
  });
});

describe('nearestNodeCounts', () => {
  const g = handGraph();

  it('counts cells at their nearest graph node, exactly when every cell is used', () => {
    const rand = rng(5);
    const n = 500;
    const xy = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      xy[2 * i] = rand() * 6;
      xy[2 * i + 1] = rand() * 3 - 1.5;
    }
    const { counts, sampled } = nearestNodeCounts(g, xy, n, 10_000);
    expect(sampled).toBe(n);
    const brute = new Float64Array(g.nodes.length);
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      g.nodes.forEach(([x, y], k) => {
        const d = (x - xy[2 * i]) ** 2 + (y - xy[2 * i + 1]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      });
      brute[best]++;
    }
    expect(Array.from(counts)).toEqual(Array.from(brute));
  });

  it('looks at an even sample of the loaded cells when there are too many, and at none past them', () => {
    const n = 1000;
    const xy = new Float32Array(n * 2).fill(9999); // far from everything, but still nearest to some node
    xy[0] = 5;
    xy[1] = 1; // cell 0 sits on node 5
    const { counts, sampled } = nearestNodeCounts(g, xy, 100, 10); // only the first 100 are loaded
    expect(sampled).toBeLessThanOrEqual(10);
    expect(sampled).toBeGreaterThan(0);
    let total = 0;
    for (const c of counts) total += c;
    expect(total).toBe(sampled);
    expect(counts[5]).toBeGreaterThanOrEqual(1); // cell 0 is always in an even sample
  });

  it('returns zeros for no cells', () => {
    const { counts, sampled } = nearestNodeCounts(g, new Float32Array(0), 0, 100);
    expect(sampled).toBe(0);
    expect(Array.from(counts)).toEqual(new Array(10).fill(0));
  });
});
