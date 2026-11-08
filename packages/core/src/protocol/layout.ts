import { childrenOf } from './trace';
import type { ProtocolTree } from './types';

export interface TreeLayout {
  /** Position of each milestone in the unit square; x is time, y spreads the lineages. */
  x: number[];
  y: number[];
}

/**
 * Lays the tree out left to right.
 *
 * Time runs along x (days, scaled so the last milestone is at 1). Fates take
 * evenly spaced rows in depth-first order, and every other milestone sits at
 * the mean of its children, so a fork is centred on what it gives rise to.
 * Days strictly increase down the tree and fate rows are distinct, so no two
 * milestones land on the same point.
 */
export function layoutTree(tree: ProtocolTree): TreeLayout {
  const ms = tree.milestones;
  const kids = childrenOf(tree);
  const n = ms.length;
  const maxDay = Math.max(1, ...ms.map(m => m.day));
  const x = ms.map(m => m.day / maxDay);
  const y = new Array<number>(n).fill(0.5);

  const preorder: number[] = [];
  const stack = ms.filter(m => m.parent === null).map(m => m.id);
  while (stack.length) {
    const at = stack.pop()!;
    preorder.push(at);
    for (let i = kids[at].length - 1; i >= 0; i--) stack.push(kids[at][i]);
  }
  const leaves = preorder.filter(id => kids[id].length === 0);
  leaves.forEach((id, row) => {
    y[id] = leaves.length === 1 ? 0.5 : row / (leaves.length - 1);
  });
  for (let i = preorder.length - 1; i >= 0; i--) {
    const id = preorder[i];
    if (kids[id].length === 0) continue;
    let sum = 0;
    for (const c of kids[id]) sum += y[c];
    y[id] = sum / kids[id].length;
  }
  return { x, y };
}
