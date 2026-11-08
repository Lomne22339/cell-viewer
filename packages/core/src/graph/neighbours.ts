import type { PrincipalGraph } from '../data/manifest';

/**
 * Neighbourhood queries on the principal graph, for "click a node, highlight
 * the closest nodes".
 *
 * "Closest" has two honest meanings on a trajectory. Along the graph —
 * geodesic distance, the sum of edge lengths — is what a developmental
 * question means: which states come just before and after this one. In the
 * embedding — straight-line distance — is what the eye sees, and it can jump
 * between branches that merely pass near each other. Both are offered; the
 * graph metric is the default.
 *
 * Graphs here are hundreds to a few thousand nodes, so plain arrays are fine;
 * the adjacency is still compressed (CSR) because it is built once and walked
 * many times.
 */

export interface GraphIndex {
  /** Node count. */
  m: number;
  /** Edges of node n are `targets[offsets[n] .. offsets[n + 1])`. */
  offsets: Uint32Array;
  targets: Uint32Array;
  /** Euclidean edge length, parallel to `targets`. */
  weights: Float64Array;
}

export function buildGraphIndex(graph: PrincipalGraph): GraphIndex {
  const m = graph.nodes.length;
  const degree = new Uint32Array(m);
  for (const [i, j] of graph.edges) {
    if (i >= m || j >= m || i === j) continue;
    degree[i]++;
    degree[j]++;
  }
  const offsets = new Uint32Array(m + 1);
  for (let n = 0; n < m; n++) offsets[n + 1] = offsets[n] + degree[n];
  const targets = new Uint32Array(offsets[m]);
  const weights = new Float64Array(offsets[m]);
  const cursor = offsets.slice(0, m);
  for (const [i, j] of graph.edges) {
    if (i >= m || j >= m || i === j) continue;
    const w = Math.hypot(graph.nodes[i][0] - graph.nodes[j][0], graph.nodes[i][1] - graph.nodes[j][1]);
    targets[cursor[i]] = j;
    weights[cursor[i]++] = w;
    targets[cursor[j]] = i;
    weights[cursor[j]++] = w;
  }
  return { m, offsets, targets, weights };
}

export function degreeOf(index: GraphIndex, node: number): number {
  return index.offsets[node + 1] - index.offsets[node];
}

export interface ShortestPaths {
  /** Geodesic distance from the source; Infinity when unreachable. */
  dist: Float64Array;
  /** Previous node on a shortest path, or -1 for the source and unreachable nodes. */
  prev: Int32Array;
}

/** Dijkstra with a binary heap. Ties settle in node-index order, so results are deterministic. */
export function shortestPaths(index: GraphIndex, source: number): ShortestPaths {
  const { m, offsets, targets, weights } = index;
  const dist = new Float64Array(m).fill(Infinity);
  const prev = new Int32Array(m).fill(-1);
  if (source < 0 || source >= m) return { dist, prev };
  dist[source] = 0;

  // Heap of node ids ordered by (dist, id). Stale entries are skipped on pop.
  const heap: number[] = [source];
  const heapDist: number[] = [0];
  const less = (a: number, b: number): boolean =>
    heapDist[a] < heapDist[b] || (heapDist[a] === heapDist[b] && heap[a] < heap[b]);
  const swap = (a: number, b: number): void => {
    [heap[a], heap[b]] = [heap[b], heap[a]];
    [heapDist[a], heapDist[b]] = [heapDist[b], heapDist[a]];
  };
  const push = (node: number, d: number): void => {
    heap.push(node);
    heapDist.push(d);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(i, p)) break;
      swap(i, p);
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top: [number, number] = [heap[0], heapDist[0]];
    const lastNode = heap.pop()!;
    const lastDist = heapDist.pop()!;
    if (heap.length) {
      heap[0] = lastNode;
      heapDist[0] = lastDist;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < heap.length && less(l, s)) s = l;
        if (r < heap.length && less(r, s)) s = r;
        if (s === i) break;
        swap(i, s);
        i = s;
      }
    }
    return top;
  };

  const done = new Uint8Array(m);
  while (heap.length) {
    const [u, du] = pop();
    if (done[u] || du > dist[u]) continue;
    done[u] = 1;
    for (let e = offsets[u]; e < offsets[u + 1]; e++) {
      const v = targets[e];
      const nd = du + weights[e];
      if (nd < dist[v] || (nd === dist[v] && !done[v] && u < prev[v])) {
        dist[v] = nd;
        prev[v] = u;
        push(v, nd);
      }
    }
  }
  return { dist, prev };
}

export type NodeKind = 'root' | 'branch' | 'leaf' | 'internal';

export function nodeKind(graph: PrincipalGraph, index: GraphIndex, node: number): NodeKind {
  if (node === graph.root) return 'root';
  const d = degreeOf(index, node);
  if (d > 2 || graph.branchPoints.includes(node)) return 'branch';
  if (d <= 1 || graph.leaves.includes(node)) return 'leaf';
  return 'internal';
}

export type NeighbourMetric = 'graph' | 'euclidean';

export interface Neighbour {
  node: number;
  distance: number;
  /** 1 for the closest. */
  rank: number;
}

/**
 * The `k` nodes closest to `source`, closest first, excluding the source.
 * Ties are broken by node index. Under the graph metric, nodes in another
 * connected component are never "close".
 */
export function closestNodes(
  graph: PrincipalGraph,
  index: GraphIndex,
  source: number,
  k: number,
  metric: NeighbourMetric = 'graph',
  paths: ShortestPaths = shortestPaths(index, source)
): Neighbour[] {
  if (source < 0 || source >= index.m || k <= 0) return [];
  const [sx, sy] = graph.nodes[source];
  const cand: { node: number; distance: number }[] = [];
  for (let n = 0; n < index.m; n++) {
    if (n === source) continue;
    const distance =
      metric === 'graph'
        ? paths.dist[n]
        : Math.hypot(graph.nodes[n][0] - sx, graph.nodes[n][1] - sy);
    if (Number.isFinite(distance)) cand.push({ node: n, distance });
  }
  cand.sort((a, b) => a.distance - b.distance || a.node - b.node);
  return cand.slice(0, k).map((c, i) => ({ ...c, rank: i + 1 }));
}

/**
 * Edges on the shortest paths from the source to each target, deduplicated,
 * each as `[from, to]` with `from` nearer the source. Drawn as the highlighted
 * stretch of trajectory joining a node to its neighbours.
 */
export function shortestPathEdges(
  prev: Int32Array,
  source: number,
  targets: Iterable<number>
): [number, number][] {
  const seen = new Set<number>();
  const out: [number, number][] = [];
  for (const t of targets) {
    let v = t;
    let guard = prev.length;
    while (v !== source && v >= 0 && guard-- > 0) {
      const u = prev[v];
      if (u < 0) break;
      if (!seen.has(v)) {
        seen.add(v);
        out.push([u, v]);
      }
      v = u;
    }
  }
  return out;
}

/** Nearest node to a world point within `maxDist`, or -1. Ties go to the lower index. */
export function nearestNode(graph: PrincipalGraph, x: number, y: number, maxDist: number): number {
  let best = -1;
  let bestD = maxDist * maxDist;
  graph.nodes.forEach(([nx, ny], n) => {
    const d = (nx - x) ** 2 + (ny - y) ** 2;
    if (d < bestD || (d === bestD && best === -1)) {
      bestD = d;
      best = n;
    }
  });
  return best;
}

/**
 * Graph pseudotime per node: geodesic distance from the root, scaled to
 * [0, 1] over the reachable nodes. Unreachable nodes get NaN.
 */
export function nodePseudotime(graph: PrincipalGraph, index: GraphIndex): Float64Array {
  const { dist } = shortestPaths(index, graph.root);
  let max = 0;
  for (const d of dist) if (Number.isFinite(d) && d > max) max = d;
  const out = new Float64Array(index.m);
  for (let n = 0; n < index.m; n++) {
    out[n] = Number.isFinite(dist[n]) ? (max > 0 ? dist[n] / max : 0) : NaN;
  }
  return out;
}
