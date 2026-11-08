import { describe, expect, it } from 'vitest';
import { synthesizeProtocol } from '@core/protocol/synthetic';
import { validateProtocolTree, type ProtocolTree } from '@core/protocol/types';
import { buildGraphIndex, shortestPaths } from '@core/graph/neighbours';
import { handGraph, randomGraph, STAGES } from './helpers/trees';

const opts = { datasetId: 'traj500k', stageLabels: STAGES };

describe('synthesizeProtocol on a graph with a known shape', () => {
  const tree = synthesizeProtocol(handGraph(), opts);
  const ms = tree.milestones;

  it('collapses the runs between junctions into five milestones', () => {
    expect(ms.map(m => m.graphNodes)).toEqual([[0, 1, 2], [3, 4, 5], [6, 7], [8], [9]]);
  });

  it('keeps the graph topology: each segment hangs off the one holding its junction', () => {
    expect(ms.map(m => m.parent)).toEqual([null, 0, 0, 2, 2]);
  });

  it('numbers milestones by their index', () => {
    ms.forEach((m, i) => expect(m.id).toBe(i));
  });

  it('names the kinds: a stem, a branching progenitor, and terminal fates', () => {
    expect(ms.map(m => m.kind)).toEqual(['stem', 'terminal', 'progenitor', 'terminal', 'terminal']);
  });

  it('says it is synthetic, at the top and in every name it invented', () => {
    expect(tree.synthetic).toBe(true);
    for (const m of ms) {
      expect(m.label).toMatch(/synthetic/i);
      for (const marker of m.markers) expect(marker).toMatch(/synthetic/i);
      for (const f of m.factors) expect(f.name).toMatch(/synthetic/i);
    }
  });

  it('gives every milestone a factor or a marker to show', () => {
    for (const m of ms) expect(m.factors.length + m.markers.length).toBeGreaterThan(0);
  });

  it('measures time along the graph: pseudotime is continuous from parent to child', () => {
    expect(ms[0].ptStart).toBe(0);
    for (const m of ms) {
      expect(m.ptEnd).toBeGreaterThanOrEqual(m.ptStart);
      if (m.parent !== null) expect(m.ptStart).toBeCloseTo(ms[m.parent].ptEnd, 12);
    }
    const idx = buildGraphIndex(handGraph());
    const { dist } = shortestPaths(idx, 0);
    const far = Math.max(...Array.from(dist));
    expect(ms[0].ptEnd).toBeCloseTo(dist[2] / far, 12);
    expect(Math.max(...ms.map(m => m.ptEnd))).toBeCloseTo(1, 12);
  });

  it('puts each milestone in the stage its end falls in', () => {
    for (const m of ms) {
      expect(m.stageIndex).toBe(Math.min(STAGES.length - 1, Math.floor(m.ptEnd * STAGES.length)));
    }
  });

  it('runs days forward by at least one per milestone', () => {
    expect(ms[0].durationDays).toBeGreaterThanOrEqual(1);
    for (const m of ms) {
      const parentDay = m.parent === null ? 0 : ms[m.parent].day;
      expect(m.day).toBeGreaterThan(parentDay);
      expect(m.durationDays).toBe(m.day - parentDay);
    }
  });

  it('passes its own validator against the graph it came from', () => {
    expect(() => validateProtocolTree(tree, handGraph().nodes.length)).not.toThrow();
  });
});

describe('synthesizeProtocol properties', () => {
  it('is deterministic, and a different seed changes the invented names', () => {
    const g = randomGraph(7, 60);
    expect(synthesizeProtocol(g, opts)).toEqual(synthesizeProtocol(g, opts));
    const other = synthesizeProtocol(g, { ...opts, seed: 99 });
    expect(other.milestones.map(m => m.factors)).not.toEqual(synthesizeProtocol(g, opts).milestones.map(m => m.factors));
    // The structure does not depend on the seed.
    expect(other.milestones.map(m => m.graphNodes)).toEqual(synthesizeProtocol(g, opts).milestones.map(m => m.graphNodes));
  });

  it.each(Array.from({ length: 40 }, (_, i) => i + 1))('random tree, seed %i: covers every node once and has one fate per leaf', seed => {
    const n = 5 + (seed * 13) % 120;
    const g = randomGraph(seed, n);
    const tree = synthesizeProtocol(g, opts);
    expect(() => validateProtocolTree(tree, n)).not.toThrow();

    const seen = new Uint8Array(n);
    for (const m of tree.milestones) for (const node of m.graphNodes) seen[node]++;
    expect(Array.from(seen).every(c => c === 1)).toBe(true);

    const terminals = tree.milestones.filter(m => m.kind === 'terminal').length;
    expect(terminals).toBe(g.leaves.length);
    expect(tree.milestones.filter(m => m.parent === null)).toHaveLength(1);
  });

  it('ignores nodes the root cannot reach instead of failing', () => {
    const g = handGraph();
    g.nodes.push([40, 40]);
    const tree = synthesizeProtocol(g, opts);
    const covered = tree.milestones.flatMap(m => m.graphNodes);
    expect(covered).not.toContain(10);
    expect(() => validateProtocolTree(tree, g.nodes.length)).not.toThrow();
  });

  it('handles a graph that is only a root', () => {
    const tree = synthesizeProtocol({ nodes: [[0, 0]], edges: [], root: 0, branchPoints: [], leaves: [] }, opts);
    expect(tree.milestones).toHaveLength(1);
    expect(tree.milestones[0].kind).toBe('stem');
    expect(tree.milestones[0].graphNodes).toEqual([0]);
  });

  it('refuses an empty graph and an empty stage list', () => {
    expect(() => synthesizeProtocol({ nodes: [], edges: [], root: 0, branchPoints: [], leaves: [] }, opts)).toThrow(/no nodes/i);
    expect(() => synthesizeProtocol(handGraph(), { ...opts, stageLabels: [] })).toThrow(/stage/i);
  });
});

describe('validateProtocolTree', () => {
  const good = (): ProtocolTree => synthesizeProtocol(handGraph(), opts);
  const mutate = (f: (t: ProtocolTree) => void): ProtocolTree => {
    const t = structuredClone(good());
    f(t);
    return t;
  };

  it('accepts a good tree and returns it', () => {
    const t = good();
    expect(validateProtocolTree(t)).toBe(t);
  });

  it.each([
    ['not an object', () => 5 as unknown],
    ['no milestones', () => mutate(t => (t.milestones = []))],
    ['two roots', () => mutate(t => (t.milestones[1].parent = null))],
    ['no root', () => mutate(t => (t.milestones[0].parent = 1))],
    ['a parent that does not exist', () => mutate(t => (t.milestones[3].parent = 99))],
    ['a cycle', () => mutate(t => { t.milestones[0].parent = 3; t.milestones[3].parent = 0; })],
    ['an id that is not its index', () => mutate(t => (t.milestones[2].id = 7))],
    ['a graph node claimed twice', () => mutate(t => t.milestones[4].graphNodes.push(0))],
    ['a graph node beyond the graph', () => mutate(t => t.milestones[4].graphNodes.push(500))],
    ['a stage that does not exist', () => mutate(t => (t.milestones[1].stageIndex = 6))],
    ['a non-finite day', () => mutate(t => (t.milestones[1].day = NaN))],
    ['a day that does not advance', () => mutate(t => (t.milestones[1].day = t.milestones[0].day))],
    ['pseudotime running backwards', () => mutate(t => (t.milestones[1].ptEnd = t.milestones[1].ptStart - 0.1))],
    ['an empty label', () => mutate(t => (t.milestones[1].label = ''))],
    ['a missing synthetic flag', () => mutate(t => ((t as unknown as { synthetic?: unknown }).synthetic = undefined))],
    ['no stage labels', () => mutate(t => (t.stageLabels = []))]
  ])('rejects %s', (_name, make) => {
    expect(() => validateProtocolTree(make(), 10)).toThrow();
  });
});
