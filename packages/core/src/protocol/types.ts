/**
 * The curated differentiation tree: a small, named, annotated tree of
 * milestones that sits over the trajectory's principal graph.
 *
 * The graph says where cells are; this says what the states along it are
 * called, when they are reached, and what is done to a culture to move from
 * one to the next. Each milestone covers a run of graph nodes, so a click on
 * the trajectory and a click on the tree mean the same thing.
 *
 * Until curated data exists the tree is derived from the graph and marked
 * `synthetic`. Every name, marker and factor in a synthetic tree is invented
 * and says so; nothing here may be read as an experimental recommendation.
 */
export type MilestoneKind = 'stem' | 'progenitor' | 'intermediate' | 'terminal';

export interface Factor {
  name: string;
  action: 'activate' | 'inhibit';
}

export interface Milestone {
  /** Equal to the milestone's index in `ProtocolTree.milestones`. */
  id: number;
  /** The milestone this one differentiates from, or null for the stem cell. */
  parent: number | null;
  label: string;
  kind: MilestoneKind;
  /** Day of culture at which the milestone is reached; strictly later than its parent's. */
  day: number;
  durationDays: number;
  /** Pseudotime, in [0, 1], at the start and end of the milestone. */
  ptStart: number;
  ptEnd: number;
  /** Index into `ProtocolTree.stageLabels` of the stage the milestone ends in. */
  stageIndex: number;
  markers: string[];
  factors: Factor[];
  /** The principal-graph nodes this milestone covers; no node belongs to two milestones. */
  graphNodes: number[];
}

export interface ProtocolTree {
  datasetId: string;
  /** True when the milestones, factors and markers are invented demo data. */
  synthetic: boolean;
  stageLabels: string[];
  milestones: Milestone[];
}

const KINDS = new Set<string>(['stem', 'progenitor', 'intermediate', 'terminal']);

function fail(message: string): never {
  throw new Error(`invalid protocol tree: ${message}`);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Throws unless `raw` is a well-formed tree: one root, no cycles, every
 * parent real, days that advance, stages that exist and no graph node shared
 * between milestones. With `graphNodeCount`, node ids must also lie inside the
 * graph. Returns the tree itself so a loader can validate in one expression.
 */
export function validateProtocolTree(raw: unknown, graphNodeCount = Infinity): ProtocolTree {
  if (!isObject(raw)) fail('not an object');
  const tree = raw as unknown as ProtocolTree;
  if (typeof tree.synthetic !== 'boolean') fail('missing synthetic flag');
  if (typeof tree.datasetId !== 'string') fail('missing dataset id');
  if (!Array.isArray(tree.stageLabels) || tree.stageLabels.length === 0) fail('no stage labels');
  if (!Array.isArray(tree.milestones) || tree.milestones.length === 0) fail('no milestones');

  const ms = tree.milestones;
  const stages = tree.stageLabels.length;
  const claimed = new Set<number>();
  let roots = 0;

  ms.forEach((m, i) => {
    if (!isObject(m)) fail(`milestone ${i} is not an object`);
    if (m.id !== i) fail(`milestone ${i} has id ${String(m.id)}`);
    if (typeof m.label !== 'string' || m.label.trim() === '') fail(`milestone ${i} has no label`);
    if (!KINDS.has(m.kind)) fail(`milestone ${i} has kind ${String(m.kind)}`);
    if (m.parent === null) roots++;
    else if (!Number.isInteger(m.parent) || m.parent < 0 || m.parent >= ms.length || m.parent === i) {
      fail(`milestone ${i} has parent ${String(m.parent)}`);
    }
    for (const key of ['day', 'durationDays', 'ptStart', 'ptEnd'] as const) {
      if (!Number.isFinite(m[key])) fail(`milestone ${i} has a non-finite ${key}`);
    }
    if (m.durationDays <= 0) fail(`milestone ${i} has no duration`);
    if (m.ptStart > m.ptEnd) fail(`milestone ${i} runs backwards in pseudotime`);
    if (!Number.isInteger(m.stageIndex) || m.stageIndex < 0 || m.stageIndex >= stages) {
      fail(`milestone ${i} is in stage ${String(m.stageIndex)}, of ${stages}`);
    }
    if (!Array.isArray(m.markers) || m.markers.some(x => typeof x !== 'string')) fail(`milestone ${i} has bad markers`);
    if (
      !Array.isArray(m.factors) ||
      m.factors.some(f => !isObject(f) || typeof f.name !== 'string' || (f.action !== 'activate' && f.action !== 'inhibit'))
    ) {
      fail(`milestone ${i} has bad factors`);
    }
    if (!Array.isArray(m.graphNodes)) fail(`milestone ${i} has no graph nodes`);
    for (const n of m.graphNodes) {
      if (!Number.isInteger(n) || n < 0 || n >= graphNodeCount) fail(`milestone ${i} claims graph node ${String(n)}`);
      if (claimed.has(n)) fail(`graph node ${n} belongs to two milestones`);
      claimed.add(n);
    }
  });
  if (roots !== 1) fail(`${roots} roots, expected 1`);

  // Walking up from every milestone must reach the root before it has taken
  // more steps than there are milestones; otherwise there is a cycle.
  for (let i = 0; i < ms.length; i++) {
    let at: number | null = i;
    let steps = 0;
    while (at !== null) {
      if (steps++ > ms.length) fail('contains a cycle');
      at = ms[at].parent;
    }
  }
  for (const m of ms) {
    if (m.parent !== null && !(m.day > ms[m.parent].day)) fail(`milestone ${m.id} is not later than its parent`);
  }
  return tree;
}
