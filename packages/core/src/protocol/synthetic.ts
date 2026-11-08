import type { PrincipalGraph } from '../data/manifest';
import { buildGraphIndex, nodePseudotime, shortestPaths } from '../graph/neighbours';
import type { Factor, Milestone, MilestoneKind, ProtocolTree } from './types';

/** Length of the invented culture, in days, from the stem cell to the last fate. */
const TOTAL_DAYS = 30;

export interface SyntheticOptions {
  datasetId: string;
  /** The dataset's stage levels, earliest first. */
  stageLabels: string[];
  /** Changes the invented factors and markers; the structure never depends on it. */
  seed?: number;
}

/** A small seeded generator, so the same graph always yields the same demo tree. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function labelFor(kind: MilestoneKind, id: number): string {
  switch (kind) {
    case 'stem':
      return 'Synthetic stem cell';
    case 'progenitor':
      return `Synthetic progenitor P${id}`;
    case 'intermediate':
      return `Synthetic intermediate I${id}`;
    default:
      return `Synthetic fate F${id}`;
  }
}

/** Invented names only: no real factor or marker is named, so none can be mistaken for advice. */
function invent(seed: number, id: number): { factors: Factor[]; markers: string[] } {
  const rand = mulberry32(Math.imul(seed, 2654435761) + Math.imul(id + 1, 40503));
  const letter = (): string => String.fromCharCode(65 + Math.floor(rand() * 26));
  const factors: Factor[] = [];
  const nFactors = 1 + Math.floor(rand() * 3);
  for (let guard = 0; factors.length < nFactors && guard < 50; guard++) {
    const name = `Synthetic factor ${letter()}${1 + Math.floor(rand() * 9)}`;
    if (factors.some(f => f.name === name)) continue;
    factors.push({ name, action: rand() < 0.65 ? 'activate' : 'inhibit' });
  }
  const markers: string[] = [];
  const nMarkers = 1 + Math.floor(rand() * 3);
  for (let guard = 0; markers.length < nMarkers && guard < 50; guard++) {
    const name = `Synthetic marker M${100 + Math.floor(rand() * 900)}`;
    if (!markers.includes(name)) markers.push(name);
  }
  return { factors, markers };
}

/**
 * Derives a demo differentiation tree from the trajectory's own graph.
 *
 * Each run of nodes between junctions becomes one milestone, so the tree has
 * exactly the graph's branching: the root's run is the stem cell, a node with
 * several children ends a progenitor, and a leaf ends a fate. Milestone ids
 * follow a depth-first walk with children in node order, so the result is the
 * same on every run. Pseudotime, and the stages and days drawn from it, come
 * from the graph; only the names, markers and factors are invented, and they
 * all say "synthetic". Nodes the root cannot reach belong to no milestone.
 */
export function synthesizeProtocol(graph: PrincipalGraph, opts: SyntheticOptions): ProtocolTree {
  if (graph.nodes.length === 0) throw new Error('graph has no nodes');
  if (opts.stageLabels.length === 0) throw new Error('at least one stage label is needed');
  const m = graph.nodes.length;
  if (!Number.isInteger(graph.root) || graph.root < 0 || graph.root >= m) {
    throw new Error('the graph root is not one of its nodes');
  }
  const seed = opts.seed ?? 1;
  const stages = opts.stageLabels.length;

  const index = buildGraphIndex(graph);
  const { dist, prev } = shortestPaths(index, graph.root);
  const pt = nodePseudotime(graph, index);
  // The graph is a tree, so each reachable node hangs off exactly one earlier node.
  const children: number[][] = Array.from({ length: m }, () => []);
  for (let n = 0; n < m; n++) {
    if (n !== graph.root && Number.isFinite(dist[n]) && prev[n] >= 0) children[prev[n]].push(n);
  }

  const milestones: Milestone[] = [];
  const stack: { start: number; parent: number | null }[] = [{ start: graph.root, parent: null }];
  while (stack.length) {
    const { start, parent } = stack.pop()!;
    const nodes = [start];
    let end = start;
    while (children[end].length === 1) {
      end = children[end][0];
      nodes.push(end);
    }
    const id = milestones.length;
    const kind: MilestoneKind =
      parent === null ? 'stem' : children[end].length === 0 ? 'terminal' : children[end].length > 1 ? 'progenitor' : 'intermediate';
    const parentMs = parent === null ? null : milestones[parent];
    const ptEnd = pt[end];
    const parentDay = parentMs ? parentMs.day : 0;
    // Days advance by at least one, so siblings and descendants never share a column.
    const day = Math.max(Math.round(ptEnd * TOTAL_DAYS), parentDay + 1);
    milestones.push({
      id,
      parent,
      label: labelFor(kind, id),
      kind,
      day,
      durationDays: day - parentDay,
      ptStart: parentMs ? parentMs.ptEnd : 0,
      ptEnd,
      stageIndex: Math.min(stages - 1, Math.floor(ptEnd * stages)),
      ...invent(seed, id),
      graphNodes: nodes
    });
    // Pushed in reverse so the lowest-numbered child is walked first.
    for (let i = children[end].length - 1; i >= 0; i--) stack.push({ start: children[end][i], parent: id });
  }

  return { datasetId: opts.datasetId, synthetic: true, stageLabels: [...opts.stageLabels], milestones };
}
