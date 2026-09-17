import type { PrincipalGraph } from '../data/manifest';

export interface GraphPath {
  path: [number, number][];
}

export interface GraphMarker {
  position: [number, number];
  kind: 'root' | 'branch' | 'leaf';
}

/**
 * Merges the principal graph's edge list into polylines.
 *
 * A monocle3 graph is a few hundred to a few thousand edges. Handing deck.gl
 * one two-point path per edge draws visible seams at every joint and costs a
 * draw-call setup per segment; merging runs between branch points gives
 * continuous strokes that read as lineages.
 */
export function graphPaths(graph: PrincipalGraph): GraphPath[] {
  const m = graph.nodes.length;
  if (m === 0 || graph.edges.length === 0) return [];

  const adj: number[][] = Array.from({ length: m }, () => []);
  graph.edges.forEach(([i, j], e) => {
    adj[i].push(e);
    adj[j].push(e);
  });
  const other = (e: number, from: number): number =>
    graph.edges[e][0] === from ? graph.edges[e][1] : graph.edges[e][0];

  const used = new Uint8Array(graph.edges.length);
  const paths: GraphPath[] = [];

  const walk = (start: number, firstEdge: number): void => {
    const path: [number, number][] = [graph.nodes[start]];
    let node = start;
    let edge = firstEdge;
    // Follow the run until it hits a branch point, a leaf, or an edge we
    // already drew. The `used` guard is also what stops a cycle from
    // spinning forever.
    while (!used[edge]) {
      used[edge] = 1;
      node = other(edge, node);
      path.push(graph.nodes[node]);
      if (adj[node].length !== 2) break;
      const next = adj[node].find(e => !used[e]);
      if (next === undefined) break;
      edge = next;
    }
    if (path.length > 1) paths.push({ path });
  };

  // Start from every junction and endpoint first, so runs are maximal.
  for (let n = 0; n < m; n++) {
    if (adj[n].length === 2) continue;
    for (const e of adj[n]) if (!used[e]) walk(n, e);
  }
  // Anything left is a pure cycle with no junction to start from.
  for (let e = 0; e < graph.edges.length; e++) {
    if (!used[e]) walk(graph.edges[e][0], e);
  }
  return paths;
}

export function graphNodeMarkers(graph: PrincipalGraph): GraphMarker[] {
  const markers: GraphMarker[] = [];
  const seen = new Set<number>();
  const push = (i: number, kind: GraphMarker['kind']): void => {
    if (seen.has(i) || !graph.nodes[i]) return;
    seen.add(i);
    markers.push({ position: graph.nodes[i], kind });
  };
  push(graph.root, 'root');
  for (const i of graph.branchPoints) push(i, 'branch');
  for (const i of graph.leaves) push(i, 'leaf');
  return markers;
}
