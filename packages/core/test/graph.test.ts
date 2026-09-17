import { describe, expect, it } from 'vitest';
import { graphNodeMarkers, graphPaths } from '@core/graph/paths';
import type { PrincipalGraph } from '@core/data/manifest';

//  0 - 1 - 2 - 3        (a chain that branches at 2)
//              \
//               4 - 5
const graph: PrincipalGraph = {
  nodes: [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [3, 2]],
  edges: [[0, 1], [1, 2], [2, 3], [2, 4], [4, 5]],
  root: 0,
  branchPoints: [2],
  leaves: [3, 5]
};

describe('graphPaths', () => {
  it('merges a chain of edges into one polyline', () => {
    const chain: PrincipalGraph = {
      ...graph, edges: [[0, 1], [1, 2], [2, 3]], branchPoints: [], leaves: [3]
    };
    const paths = graphPaths(chain);
    expect(paths).toHaveLength(1);
    expect(paths[0].path).toHaveLength(4);
  });

  it('splits at a branch point instead of drawing through it', () => {
    const paths = graphPaths(graph);
    expect(paths.length).toBeGreaterThan(1);
    const covered = new Set<string>();
    for (const p of paths) {
      for (let i = 0; i < p.path.length - 1; i++) {
        covered.add([p.path[i].join(), p.path[i + 1].join()].sort().join('|'));
      }
    }
    expect(covered.size).toBe(graph.edges.length);
  });

  it('covers every edge exactly once', () => {
    let segments = 0;
    for (const p of graphPaths(graph)) segments += p.path.length - 1;
    expect(segments).toBe(graph.edges.length);
  });

  it('returns nothing for an empty graph', () => {
    expect(graphPaths({ nodes: [], edges: [], root: 0, branchPoints: [], leaves: [] })).toEqual([]);
  });

  it('does not loop forever on a cyclic graph', () => {
    const cyclic: PrincipalGraph = {
      nodes: [[0, 0], [1, 0], [1, 1]],
      edges: [[0, 1], [1, 2], [2, 0]],
      root: 0, branchPoints: [], leaves: []
    };
    let segments = 0;
    for (const p of graphPaths(cyclic)) segments += p.path.length - 1;
    expect(segments).toBe(3);
  });
});

describe('graphNodeMarkers', () => {
  it('labels root, branch and leaf nodes', () => {
    const markers = graphNodeMarkers(graph);
    expect(markers.map(m => m.kind).sort()).toEqual(['branch', 'leaf', 'leaf', 'root']);
    expect(markers.find(m => m.kind === 'root')!.position).toEqual([0, 0]);
  });
});
