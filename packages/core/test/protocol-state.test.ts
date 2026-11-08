import { describe, expect, it } from 'vitest';
import { synthesizeProtocol } from '@core/protocol/synthetic';
import { ProtocolState } from '@core/protocol/state';
import { chainTo, milestoneAtTime, stageTime } from '@core/protocol/trace';
import { handGraph, STAGES } from './helpers/trees';

const tree = synthesizeProtocol(handGraph(), { datasetId: 't', stageLabels: STAGES });
// Own cell weight per milestone: the fate 4 is the most crowded leaf.
const weights = [1, 2, 1, 3, 9];

const fresh = (w: number[] = weights): ProtocolState => new ProtocolState(tree, w);

describe('ProtocolState', () => {
  it('starts with nothing traced and the leaf with the most cells as the lineage', () => {
    const s = fresh().snapshot();
    expect(s.clicked).toBeNull();
    expect(s.stage).toBeNull();
    expect(s.target).toBeNull();
    expect(s.traced).toEqual([]);
    expect(s.focus).toBeNull();
    expect(s.lineageLeaf).toBe(4);
    expect(s.lineage).toEqual([0, 2, 4]);
  });

  it('breaks a tie between leaves toward the lower id', () => {
    expect(fresh([0, 0, 0, 0, 0]).snapshot().lineageLeaf).toBe(1);
  });

  describe('clicking a milestone', () => {
    it('traces back to the stem and targets the milestone', () => {
      const s = fresh();
      s.click(3);
      expect(s.snapshot()).toMatchObject({ clicked: 3, target: 3, traced: [0, 2, 3], lineageLeaf: 3, focus: 2 });
    });

    it('follows the heaviest lineage below a fork for the timepoint, but traces only to the click', () => {
      const s = fresh();
      s.click(2);
      expect(s.snapshot()).toMatchObject({ target: 2, traced: [0, 2], lineageLeaf: 4, lineage: [0, 2, 4] });
    });

    it('ignores ids that are not milestones', () => {
      const s = fresh();
      s.click(3);
      for (const bad of [-1, 5, 2.5, NaN, Infinity]) s.click(bad);
      expect(s.snapshot().clicked).toBe(3);
    });

    it('clears with null', () => {
      const s = fresh();
      s.click(3);
      s.click(null);
      expect(s.snapshot()).toMatchObject({ clicked: null, target: null, traced: [] });
    });
  });

  describe('choosing a timepoint', () => {
    it('with no click, slides along the default lineage', () => {
      const s = fresh();
      s.setStage(5);
      const expected = milestoneAtTime(tree, [0, 2, 4], stageTime(5, STAGES.length));
      expect(s.snapshot()).toMatchObject({ stage: 5, target: expected, lineageLeaf: 4 });
      expect(s.snapshot().traced[0]).toBe(0);
      expect(s.snapshot().traced.at(-1)).toBe(expected);
    });

    it('with a click, slides along the clicked lineage, later or earlier', () => {
      const s = fresh();
      s.click(3);
      s.setStage(5);
      expect(s.snapshot().target).toBe(milestoneAtTime(tree, [0, 2, 3], stageTime(5, STAGES.length)));
      s.setStage(0);
      const early = s.snapshot();
      expect(early.target).toBe(milestoneAtTime(tree, [0, 2, 3], stageTime(0, STAGES.length)));
      // Going back in time reaches an ancestor of the click, still on its lineage.
      expect(early.traced).toEqual(chainTo(tree, early.target!));
      expect([0, 2, 3]).toContain(early.target);
      expect(early.clicked).toBe(3);
    });

    it('is cleared by null and ignores a stage that does not exist', () => {
      const s = fresh();
      s.setStage(2);
      for (const bad of [-1, 6, 1.5, NaN]) s.setStage(bad);
      expect(s.snapshot().stage).toBe(2);
      s.setStage(null);
      expect(s.snapshot()).toMatchObject({ stage: null, target: null });
    });

    it('survives clearing the click', () => {
      const s = fresh();
      s.click(3);
      s.setStage(4);
      s.click(null);
      expect(s.snapshot().stage).toBe(4);
      expect(s.snapshot().lineageLeaf).toBe(4);
      expect(s.snapshot().target).not.toBeNull();
    });
  });

  describe('stepping through the path', () => {
    it('starts on the target and moves toward the stem and back, clamped', () => {
      const s = fresh();
      s.click(3);
      expect(s.snapshot().focus).toBe(2);
      s.step(-1);
      expect(s.snapshot().focus).toBe(1);
      s.step(-1);
      s.step(-1);
      expect(s.snapshot().focus).toBe(0);
      s.step(1);
      expect(s.snapshot().focus).toBe(1);
      s.step(10);
      expect(s.snapshot().focus).toBe(2);
    });

    it('does nothing with nothing traced, and resets to the target on a new choice', () => {
      const s = fresh();
      s.step(1);
      expect(s.snapshot().focus).toBeNull();
      s.click(3);
      s.step(-2);
      s.click(1);
      expect(s.snapshot().focus).toBe(s.snapshot().traced.length - 1);
    });
  });

  describe('listeners', () => {
    it('hear about real changes only, and can unsubscribe', () => {
      const s = fresh();
      let calls = 0;
      const off = s.subscribe(() => calls++);
      s.click(3);
      s.click(3);
      s.setStage(1);
      s.setStage(1);
      expect(calls).toBe(2);
      s.step(0);
      expect(calls).toBe(2);
      off();
      s.click(1);
      expect(calls).toBe(2);
    });

    it('are given the new snapshot', () => {
      const s = fresh();
      let seen: ReturnType<ProtocolState['snapshot']> | null = null;
      s.subscribe(snap => (seen = snap));
      s.click(1);
      expect(seen).toMatchObject({ clicked: 1, traced: [0, 1] });
    });
  });
});
