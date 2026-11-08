import type { PrincipalGraph } from '../../src/data/manifest';

/** A small deterministic generator, so a failing property test can be replayed from its seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A graph whose shape is known by hand:
 *
 *   0 - 1 - 2 +- 3 - 4 - 5            (leaf 5)
 *             `- 6 - 7 +- 8           (leaf 8)
 *                      `- 9           (leaf 9)
 *
 * Collapsed between junctions that is five segments: [0,1,2], [3,4,5],
 * [6,7], [8] and [9].
 */
export function handGraph(): PrincipalGraph {
  return {
    nodes: [
      [0, 0], [1, 0], [2, 0],
      [3, 1], [4, 1], [5, 1],
      [3, -1], [4, -1],
      [5, -0.5], [5, -1.5]
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [2, 6], [6, 7], [7, 8], [7, 9]],
    root: 0,
    branchPoints: [2, 7],
    leaves: [5, 8, 9]
  };
}

/** A random tree of `n` nodes rooted at 0, with edges drawn in arbitrary orientation. */
export function randomGraph(seed: number, n: number): PrincipalGraph {
  const rand = rng(seed);
  const nodes: [number, number][] = [[0, 0]];
  const edges: [number, number][] = [];
  const degree = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    // Mostly extend a recent node, so there are long chains as well as forks.
    const parent = rand() < 0.7 ? i - 1 : Math.floor(rand() * i);
    const [px, py] = nodes[parent];
    nodes.push([px + 1 + rand(), py + (rand() - 0.5) * 2]);
    edges.push(rand() < 0.5 ? [parent, i] : [i, parent]);
    degree[parent]++;
    degree[i]++;
  }
  const branchPoints: number[] = [];
  const leaves: number[] = [];
  for (let i = 0; i < n; i++) {
    if (degree[i] > 2) branchPoints.push(i);
    if (degree[i] === 1 && i !== 0) leaves.push(i);
  }
  return { nodes, edges, root: 0, branchPoints, leaves };
}

export const STAGES = ['E9.5', 'E12.5', 'E15.5', 'P0', 'P7', 'adult'];
