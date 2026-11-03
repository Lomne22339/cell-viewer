import type { PrincipalGraph } from '../data/manifest';

export interface GraphPath {
  path: [number, number][];
}

export interface GraphMarker {
  position: [number, number];
  kind: 'root' | 'branch' | 'leaf';
}

/** Merges edges into polylines between branch points, so deck.gl draws seamless strokes. */
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
    // The `used` guard also stops a cycle from spinning forever.
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

  for (let n = 0; n < m; n++) {
    if (adj[n].length === 2) continue;
    for (const e of adj[n]) if (!used[e]) walk(n, e);
  }
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
