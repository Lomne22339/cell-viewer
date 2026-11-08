import { describe, expect, it } from 'vitest';
import type { PrincipalGraph } from '@core/data/manifest';
import {
  buildGraphIndex,
  closestNodes,
  degreeOf,
  nearestNode,
  nodeKind,
  nodePseudotime,
  shortestPathEdges,
  shortestPaths
} from '@core/graph/neighbours';

//  0 - 1 - 2 - 3        (unit spacing; branches at 2)
//              \
//               4 - 5
const graph: PrincipalGraph = {
  nodes: [[0, 0], [1, 0], [2, 0], [3, 0], [2, 1], [2, 2]],
  edges: [[0, 1], [1, 2], [2, 3], [2, 4], [4, 5]],
  root: 0,
  branchPoints: [2],
  leaves: [3, 5]
};

/** Floyd–Warshall reference on random weighted graphs. */
function bruteDistances(g: PrincipalGraph): number[][] {
  const m = g.nodes.length;
  const d = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => (i === j ? 0 : Infinity)));
  for (const [i, j] of g.edges) {
    const w = Math.hypot(g.nodes[i][0] - g.nodes[j][0], g.nodes[i][1] - g.nodes[j][1]);
    d[i][j] = Math.min(d[i][j], w);
    d[j][i] = Math.min(d[j][i], w);
  }
  for (let k = 0; k < m; k++)
    for (let i = 0; i < m; i++)
      for (let j = 0; j < m; j++) if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j];
  return d;
}

function randomGraph(seed: number, m: number, extraEdges: number): PrincipalGraph {
  let s = seed >>> 0;
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const nodes: [number, number][] = Array.from({ length: m }, () => [rnd() * 50, rnd() * 50]);
  const edges: [number, number][] = [];
  for (let n = 1; n < m; n++) edges.push([Math.floor(rnd() * n), n]);
  for (let e = 0; e < extraEdges; e++) edges.push([Math.floor(rnd() * m), Math.floor(rnd() * m)]);
  return { nodes, edges, root: 0, branchPoints: [], leaves: [] };
}

describe('graph index and shortest paths', () => {
  it('builds a symmetric adjacency with edge lengths', () => {
    const idx = buildGraphIndex(graph);
    expect(degreeOf(idx, 2)).toBe(3);
    expect(degreeOf(idx, 0)).toBe(1);
  });

  it('matches Floyd–Warshall on random graphs, cycles included', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const g = randomGraph(seed, 40, seed % 4 === 0 ? 0 : 8);
      const ref = bruteDistances(g);
      const idx = buildGraphIndex(g);
      for (const src of [0, 7, 39]) {
        const { dist } = shortestPaths(idx, src);
        for (let n = 0; n < 40; n++) expect(dist[n]).toBeCloseTo(ref[src][n], 9);
      }
    }
  });

  it('reports unreachable nodes as Infinity with no predecessor', () => {
    const g: PrincipalGraph = { ...graph, edges: [[0, 1], [2, 3]] };
    const { dist, prev } = shortestPaths(buildGraphIndex(g), 0);
    expect(dist[2]).toBe(Infinity);
    expect(prev[2]).toBe(-1);
  });
});

describe('closestNodes (UI-4)', () => {
  const idx = buildGraphIndex(graph);

  it('ranks by distance along the trajectory, excluding the clicked node', () => {
    const near = closestNodes(graph, idx, 2, 3, 'graph');
    expect(near.map(n => n.node)).toEqual([1, 3, 4]);
    expect(near.map(n => n.rank)).toEqual([1, 2, 3]);
    expect(near.every(n => n.distance === 1)).toBe(true);
  });

  it('differs from straight-line distance where branches pass close by', () => {
    // Node 5 at (2,2) is 2 along the graph from 4... but from node 3 (3,0):
    // graph distance to 5 is 3, Euclidean is sqrt(5) ~ 2.24, closer than node 1 (2).
    const g3 = closestNodes(graph, idx, 3, 5, 'graph').map(n => n.node);
    const e3 = closestNodes(graph, idx, 3, 5, 'euclidean').map(n => n.node);
    expect(g3).toEqual([2, 1, 4, 0, 5]);
    expect(e3).toEqual([2, 4, 1, 5, 0]);
  });

  it('matches a sorted reference on random graphs for every k', () => {
    for (let seed = 3; seed <= 8; seed++) {
      const g = randomGraph(seed, 30, 4);
      const ix = buildGraphIndex(g);
      const ref = bruteDistances(g)[5];
      const want = ref
        .map((d, n) => ({ n, d }))
        .filter(x => x.n !== 5 && Number.isFinite(x.d))
        .sort((a, b) => a.d - b.d || a.n - b.n)
        .map(x => x.n);
      for (const k of [1, 4, 12, 50]) {
        expect(closestNodes(g, ix, 5, k, 'graph').map(n => n.node)).toEqual(want.slice(0, k));
      }
    }
  });

  it('handles k <= 0 and an invalid source', () => {
    expect(closestNodes(graph, idx, 2, 0)).toEqual([]);
    expect(closestNodes(graph, idx, 99, 3)).toEqual([]);
  });

  it('returns the edges joining the source to its neighbours, once each', () => {
    const { prev } = shortestPaths(idx, 0);
    const edges = shortestPathEdges(prev, 0, [3, 5, 2]);
    const keys = edges.map(([a, b]) => `${a}-${b}`).sort();
    expect(keys).toEqual(['0-1', '1-2', '2-3', '2-4', '4-5']);
  });
});

describe('node lookup and classification', () => {
  const idx = buildGraphIndex(graph);

  it('finds the nearest node within a radius, else -1', () => {
    expect(nearestNode(graph, 2.1, 0.9, 0.5)).toBe(4);
    expect(nearestNode(graph, 10, 10, 0.5)).toBe(-1);
  });

  it('classifies root, branch, leaf and internal nodes', () => {
    expect(nodeKind(graph, idx, 0)).toBe('root');
    expect(nodeKind(graph, idx, 2)).toBe('branch');
    expect(nodeKind(graph, idx, 5)).toBe('leaf');
    expect(nodeKind(graph, idx, 1)).toBe('internal');
  });

  it('scales graph pseudotime from the root to [0, 1]', () => {
    const pt = nodePseudotime(graph, idx);
    // Geodesic distances from the root: node 2 is 2, node 3 is 3, node 5 is 4 (the farthest).
    expect(pt[0]).toBe(0);
    expect(pt[2]).toBeCloseTo(0.5);
    expect(pt[3]).toBeCloseTo(0.75);
    expect(pt[5]).toBeCloseTo(1);
  });
});
