import type { PrincipalGraph } from '../data/manifest';

export interface NodeCounts {
  /** Sampled cells whose nearest graph node is `n`. */
  counts: Float64Array;
  /** How many cells were looked at. */
  sampled: number;
}

/**
 * Cells per graph node, by nearest node.
 *
 * Only the first `count` cells are real (invariant 5), and past `maxSamples`
 * an even stride through them is used: ranking the lineages by crowding does
 * not need every one of ten million cells, and a flat scan of a few hundred
 * nodes per sampled cell stays cheap. The loop allocates nothing per cell.
 */
export function nearestNodeCounts(
  graph: PrincipalGraph,
  xy: Float32Array,
  count: number,
  maxSamples: number
): NodeCounts {
  const m = graph.nodes.length;
  const counts = new Float64Array(m);
  const have = Math.min(count, xy.length >> 1);
  if (have <= 0 || m === 0) return { counts, sampled: 0 };
  const nx = new Float64Array(m);
  const ny = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    nx[k] = graph.nodes[k][0];
    ny[k] = graph.nodes[k][1];
  }
  const stride = Math.max(1, Math.ceil(have / Math.max(1, maxSamples)));
  let sampled = 0;
  for (let i = 0; i < have; i += stride) {
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < m; k++) {
      const dx = nx[k] - x;
      const dy = ny[k] - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    counts[best]++;
    sampled++;
  }
  return { counts, sampled };
}
