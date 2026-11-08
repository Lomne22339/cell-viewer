import { describe, expect, it } from 'vitest';
import { synthesizeProtocol } from '@core/protocol/synthetic';
import { childrenOf } from '@core/protocol/trace';
import { layoutTree } from '@core/protocol/layout';
import { assignSlots } from '@core/protocol/panels';
import { handGraph, randomGraph, STAGES } from './helpers/trees';

const opts = { datasetId: 't', stageLabels: STAGES };

describe('layoutTree', () => {
  const hand = synthesizeProtocol(handGraph(), opts);

  it('puts time on x and spreads the fates down y in order', () => {
    const { x, y } = layoutTree(hand);
    const days = hand.milestones.map(m => m.day);
    const maxDay = Math.max(...days);
    hand.milestones.forEach((m, i) => expect(x[i]).toBeCloseTo(m.day / maxDay, 12));
    // Fates 1, 3 and 4 are the leaves, top to bottom in depth-first order.
    expect(y[1]).toBeLessThan(y[3]);
    expect(y[3]).toBeLessThan(y[4]);
  });

  it('centres a fork on its children', () => {
    const { y } = layoutTree(hand);
    expect(y[2]).toBeCloseTo((y[3] + y[4]) / 2, 12);
    expect(y[0]).toBeCloseTo((y[1] + y[2]) / 2, 12);
  });

  it('keeps everything inside the unit square', () => {
    const { x, y } = layoutTree(hand);
    for (const v of [...x, ...y]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic', () => {
    expect(layoutTree(hand)).toEqual(layoutTree(hand));
  });

  it('lays out a lone milestone in the middle of the height', () => {
    const one = synthesizeProtocol({ nodes: [[0, 0]], edges: [], root: 0, branchPoints: [], leaves: [] }, opts);
    const { y } = layoutTree(one);
    expect(y[0]).toBe(0.5);
  });

  it.each(Array.from({ length: 20 }, (_, i) => i + 1))('random tree %i: parents sit left of children and no two nodes overlap', seed => {
    const tree = synthesizeProtocol(randomGraph(seed, 15 + seed * 6), opts);
    const { x, y } = layoutTree(tree);
    const kids = childrenOf(tree);
    tree.milestones.forEach((m, i) => {
      for (const c of kids[i]) expect(x[c]).toBeGreaterThan(x[i]);
      expect(Number.isFinite(x[i]) && Number.isFinite(y[i])).toBe(true);
      if (kids[i].length) {
        const ys = kids[i].map(c => y[c]);
        expect(y[i]).toBeGreaterThanOrEqual(Math.min(...ys) - 1e-12);
        expect(y[i]).toBeLessThanOrEqual(Math.max(...ys) + 1e-12);
      }
      expect(m.id).toBe(i);
    });
    const seen = new Set<string>();
    for (let i = 0; i < tree.milestones.length; i++) {
      const key = `${x[i].toFixed(9)},${y[i].toFixed(9)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('assignSlots', () => {
  const order = ['map', 'graph', 'recipe'];

  it('leaves every panel in its own cell when nothing is expanded', () => {
    expect(assignSlots(order, null)).toEqual({ map: 'map', graph: 'graph', recipe: 'recipe' });
  });

  it.each([
    ['map', { map: 'main', graph: 'rail1', recipe: 'rail2' }],
    ['graph', { graph: 'main', map: 'rail1', recipe: 'rail2' }],
    ['recipe', { recipe: 'main', map: 'rail1', graph: 'rail2' }]
  ])('expanding %s puts it in the main area and the others on the rail in their usual order', (id, expected) => {
    expect(assignSlots(order, id)).toEqual(expected);
  });

  it('treats an unknown id as nothing expanded', () => {
    expect(assignSlots(order, 'nope')).toEqual(assignSlots(order, null));
  });

  it('refuses duplicate panel ids', () => {
    expect(() => assignSlots(['a', 'a', 'b'], null)).toThrow(/duplicate/i);
  });
});
