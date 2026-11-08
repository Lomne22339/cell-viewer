import type { ProtocolTree } from './types';

/** Children of every milestone, in id order. */
export function childrenOf(tree: ProtocolTree): number[][] {
  const kids: number[][] = Array.from({ length: tree.milestones.length }, () => []);
  for (const m of tree.milestones) if (m.parent !== null) kids[m.parent].push(m.id);
  return kids;
}

/** The fates (milestones with no children) at or below `id`, in id order. */
export function terminalsUnder(tree: ProtocolTree, id: number): number[] {
  const kids = childrenOf(tree);
  const out: number[] = [];
  const stack = [id];
  while (stack.length) {
    const at = stack.pop()!;
    if (kids[at].length === 0) out.push(at);
    else stack.push(...kids[at]);
  }
  return out.sort((a, b) => a - b);
}

/**
 * The way back to the stem cell: the milestone ids from the stem to `id`, in
 * order. Empty for an id that is not a milestone.
 */
export function chainTo(tree: ProtocolTree, id: number): number[] {
  const ms = tree.milestones;
  if (!Number.isInteger(id) || id < 0 || id >= ms.length) return [];
  const chain: number[] = [];
  for (let at: number | null = id, steps = 0; at !== null && steps <= ms.length; at = ms[at].parent, steps++) {
    chain.push(at);
  }
  return chain.reverse();
}

/** The milestone each graph node belongs to, or -1 for a node no milestone covers. */
export function nodeMilestones(tree: ProtocolTree, nodeCount: number): Int32Array {
  const map = new Int32Array(nodeCount).fill(-1);
  for (const m of tree.milestones) for (const n of m.graphNodes) if (n >= 0 && n < nodeCount) map[n] = m.id;
  return map;
}

export interface Branching {
  /** The milestone where the lineage forks. */
  at: number;
  /** The branch the path follows, or null when the path ends at the fork. */
  taken: number | null;
  /** The other branches: those given up, or every option ahead when `taken` is null. */
  alternatives: number[];
  /** Fates that can no longer be reached because of the branch taken. */
  excludedFates: number[];
}

/**
 * Every fork on a path, with the branch taken and what taking it rules out.
 * A path that stops at a fork lists the options ahead instead.
 */
export function branchesAlong(tree: ProtocolTree, chain: number[]): Branching[] {
  const kids = childrenOf(tree);
  const out: Branching[] = [];
  chain.forEach((id, i) => {
    const options = kids[id];
    if (!options || options.length < 2) return;
    const taken = i + 1 < chain.length ? chain[i + 1] : null;
    if (taken === null) {
      out.push({ at: id, taken: null, alternatives: [...options], excludedFates: [] });
      return;
    }
    const alternatives = options.filter(c => c !== taken);
    const excludedFates = alternatives.flatMap(a => terminalsUnder(tree, a)).sort((a, b) => a - b);
    out.push({ at: id, taken, alternatives, excludedFates });
  });
  return out;
}

/** Middle of a stage's band of pseudotime, for `count` equal stages. */
export function stageTime(stage: number, count: number): number {
  return (stage + 0.5) / count;
}

/**
 * Where on a path the culture is at pseudotime `t`: the first milestone that
 * has not ended by then, or the last one if all have. Null for an empty path.
 */
export function milestoneAtTime(tree: ProtocolTree, chain: number[], t: number): number | null {
  if (chain.length === 0) return null;
  for (const id of chain) if (tree.milestones[id].ptEnd >= t) return id;
  return chain[chain.length - 1];
}

/** Cells per milestone, from cells per graph node. */
export function milestoneWeights(tree: ProtocolTree, nodeMap: Int32Array, nodeCounts: ArrayLike<number>): number[] {
  const own = new Array<number>(tree.milestones.length).fill(0);
  for (let n = 0; n < nodeMap.length; n++) if (nodeMap[n] >= 0) own[nodeMap[n]] += nodeCounts[n] ?? 0;
  return own;
}

/** Each milestone's own weight plus everything below it. */
export function subtreeWeights(tree: ProtocolTree, own: number[]): number[] {
  const kids = childrenOf(tree);
  const roots = tree.milestones.filter(m => m.parent === null).map(m => m.id);
  const order: number[] = [];
  const stack = [...roots];
  while (stack.length) {
    const at = stack.pop()!;
    order.push(at);
    stack.push(...kids[at]);
  }
  const sub = own.slice();
  for (let i = order.length - 1; i >= 0; i--) {
    const at = order[i];
    const parent = tree.milestones[at].parent;
    if (parent !== null) sub[parent] += sub[at];
  }
  return sub;
}

/**
 * The fate reached from `from` by always taking the child with the most cells
 * below it. Ties go to the lower id, so the default lineage is stable.
 */
export function heaviestLeaf(tree: ProtocolTree, from: number, subtree: number[]): number {
  const kids = childrenOf(tree);
  let at = from;
  while (kids[at].length) {
    let best = kids[at][0];
    for (const c of kids[at]) if (subtree[c] > subtree[best]) best = c;
    at = best;
  }
  return at;
}
