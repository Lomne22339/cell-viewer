import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '@core/anatomy/models';
import {
  ORGAN_VIEW_ORGANS,
  bodySegmentFor,
  isOrganDataset,
  organDatasetIds,
  organLabel,
  organsTopToBottom
} from '@core/organ/organs';
import { linkSelections, type SelectionPort } from '@core/organ/link';
import { connectorPath } from '@core/organ/connector';

describe('the Organ View organs', () => {
  const registry = createDefaultRegistry();

  it('are the heart, brain and liver, in that order', () => {
    expect([...ORGAN_VIEW_ORGANS]).toEqual(['heart', 'brain', 'liver']);
  });

  it('each have a registered figure with parts to select', () => {
    for (const id of ORGAN_VIEW_ORGANS) {
      const model = registry.get(id);
      expect(model, id).toBeDefined();
      expect(model!.segments.length).toBeGreaterThan(2);
      expect(organLabel(registry, id)).toBe(model!.label);
    }
  });

  it('each sit at a place on the body, found from the body figure itself', () => {
    const body = registry.get('body')!;
    for (const id of ORGAN_VIEW_ORGANS) {
      const at = bodySegmentFor(body, id);
      expect(at, id).toBeGreaterThanOrEqual(0);
      expect(body.segments[at].drillDown).toBe(id);
    }
    expect(bodySegmentFor(body, 'spleen')).toBe(-1);
    expect(bodySegmentFor(body, '')).toBe(-1);
  });

  it('can be listed top to bottom as they sit on the body, so connectors to a column of cards do not cross', () => {
    const body = registry.get('body')!;
    expect(organsTopToBottom(body, ORGAN_VIEW_ORGANS)).toEqual(['brain', 'heart', 'liver']);
    // Whatever order it is given, the same list comes back; unknown organs go last, in the order given.
    expect(organsTopToBottom(body, ['liver', 'heart', 'brain'])).toEqual(['brain', 'heart', 'liver']);
    expect(organsTopToBottom(body, ['liver', 'spleen', 'brain', 'nope'])).toEqual(['brain', 'liver', 'spleen', 'nope']);
    expect(organsTopToBottom(body, [])).toEqual([]);
  });

  it('name their datasets the way the server writes them', () => {
    // The same strings server/organs.py produces; a rename on one side must fail here.
    expect(organDatasetIds('heart')).toEqual({ umap: 'organ-heart-umap', trajectory: 'organ-heart-traj' });
    expect(organDatasetIds('brain')).toEqual({ umap: 'organ-brain-umap', trajectory: 'organ-brain-traj' });
    expect(organDatasetIds('liver')).toEqual({ umap: 'organ-liver-umap', trajectory: 'organ-liver-traj' });
  });

  it('use dataset ids that are safe as URL segments', () => {
    for (const id of ORGAN_VIEW_ORGANS) {
      for (const ds of Object.values(organDatasetIds(id))) expect(ds).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });

  it('refuse an organ the view does not have', () => {
    expect(() => organDatasetIds('spleen')).toThrow(/organ/i);
    expect(() => organDatasetIds('../heart')).toThrow(/organ/i);
  });

  it('tell organ datasets from ordinary ones, so the dataset list can leave them out', () => {
    expect(isOrganDataset('organ-heart-umap')).toBe(true);
    expect(isOrganDataset('organ-liver-traj')).toBe(true);
    for (const id of ['traj500k', 'sim1m', 'atlas300k', 'organs', 'my-organ-set']) expect(isOrganDataset(id)).toBe(false);
  });
});

/** A selection holder like the viewer's: applying a selection notifies its listeners at once. */
function port(): SelectionPort & { applied: (Uint32Array | null)[]; set: (i: Uint32Array | null) => void; listeners: number } {
  const listeners = new Set<(i: Uint32Array | null) => void>();
  const self = {
    applied: [] as (Uint32Array | null)[],
    get listeners() {
      return listeners.size;
    },
    subscribe(cb: (i: Uint32Array | null) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    apply(i: Uint32Array | null) {
      self.applied.push(i);
      for (const cb of listeners) cb(i);
    },
    /** A selection made by the user in this view, not by the link. */
    set(i: Uint32Array | null) {
      for (const cb of listeners) cb(i);
    }
  };
  return self;
}

describe('linkSelections', () => {
  it('copies a selection made in either view to the other, once, without echoing', () => {
    const a = port();
    const b = port();
    linkSelections(a, b);
    const picked = Uint32Array.from([3, 5, 8]);
    a.set(picked);
    expect(b.applied).toEqual([picked]);
    expect(a.applied).toEqual([]);
    const back = Uint32Array.from([1, 2]);
    b.set(back);
    expect(a.applied).toEqual([back]);
    expect(b.applied).toEqual([picked]);
  });

  it('carries a cleared selection too', () => {
    const a = port();
    const b = port();
    linkSelections(a, b);
    a.set(Uint32Array.from([1]));
    a.set(null);
    expect(b.applied).toEqual([Uint32Array.from([1]), null]);
  });

  it('does not ping-pong when applying a selection makes the other view report it', () => {
    const a = port();
    const b = port();
    linkSelections(a, b);
    for (let i = 0; i < 5; i++) a.set(Uint32Array.from([i]));
    expect(b.applied).toHaveLength(5);
    expect(a.applied).toHaveLength(0);
  });

  it('stops when disposed, on both sides', () => {
    const a = port();
    const b = port();
    const dispose = linkSelections(a, b);
    expect(a.listeners).toBe(1);
    expect(b.listeners).toBe(1);
    dispose();
    expect(a.listeners).toBe(0);
    expect(b.listeners).toBe(0);
    a.set(Uint32Array.from([1]));
    expect(b.applied).toEqual([]);
  });

  it('keeps listening after the other side throws while applying', () => {
    const a = port();
    const b = port();
    let first = true;
    const origApply = b.apply.bind(b);
    b.apply = i => {
      if (first) {
        first = false;
        throw new Error('view was destroyed');
      }
      origApply(i);
    };
    linkSelections(a, b);
    expect(() => a.set(Uint32Array.from([1]))).toThrow('view was destroyed');
    a.set(Uint32Array.from([2]));
    expect(b.applied).toEqual([Uint32Array.from([2])]);
  });
});

describe('connectorPath', () => {
  const nums = (d: string): number[] => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

  it('is a smooth curve from one point to the other', () => {
    const d = connectorPath([10, 20], [110, 80]);
    expect(d.startsWith('M10 20')).toBe(true);
    const n = nums(d);
    expect(n.slice(0, 2)).toEqual([10, 20]);
    expect(n.slice(-2)).toEqual([110, 80]);
    expect(d).toContain('C');
  });

  it('leaves and arrives horizontally, whichever way it runs', () => {
    for (const [from, to] of [
      [[0, 0], [100, 50]],
      [[100, 0], [0, 50]]
    ] as [number, number][][]) {
      const n = nums(connectorPath(from as [number, number], to as [number, number]));
      // M x0 y0 C c1x c1y c2x c2y x1 y1 : both control points keep their end's y.
      expect(n[3]).toBe(n[1]);
      expect(n[5]).toBe(n[7]);
    }
  });

  it('is a valid path for coincident points and rounds long decimals', () => {
    expect(connectorPath([5, 5], [5, 5])).toMatch(/^M5 5 C/);
    const d = connectorPath([0.123456, 0], [10.987654, 3]);
    for (const x of nums(d)) expect(String(x).replace(/^-?\d+\.?/, '').length).toBeLessThanOrEqual(2);
  });

  it('is deterministic', () => {
    expect(connectorPath([1, 2], [30, 40])).toBe(connectorPath([1, 2], [30, 40]));
  });
});
