import type { OrganRegistry } from '../anatomy/registry';
import { pathBounds } from '../anatomy/path';
import type { OrganModel } from '../anatomy/types';

/**
 * The organs the Organ View shows: the ones whose figure has named parts and
 * which the body figure opens by double-click. They are listed here, not
 * discovered, so a new organ figure does not silently appear in the view
 * without the datasets behind it.
 */
export const ORGAN_VIEW_ORGANS = ['heart', 'brain', 'liver'] as const;
export type OrganViewOrgan = (typeof ORGAN_VIEW_ORGANS)[number];

export interface OrganDatasets {
  /** The organ's cells in a UMAP embedding. */
  umap: string;
  /** The same cells, in the same order, laid out along a trajectory. */
  trajectory: string;
}

const KNOWN = new Set<string>(ORGAN_VIEW_ORGANS);

/**
 * Tile ids of an organ's two datasets, as `server/organs.py` writes them. The
 * strings are written out in both places and pinned by a test on each side,
 * because a mismatch would only show as a 404 in the browser.
 */
export function organDatasetIds(organ: string): OrganDatasets {
  if (!KNOWN.has(organ)) throw new Error(`unknown organ "${organ}"; the Organ View has ${ORGAN_VIEW_ORGANS.join(', ')}`);
  return { umap: `organ-${organ}-umap`, trajectory: `organ-${organ}-traj` };
}

/** Whether a dataset id belongs to the Organ View rather than the dataset switcher. */
export function isOrganDataset(id: string): boolean {
  return id.startsWith('organ-');
}

/** Index of the body segment that opens `organId` on double-click, or -1. */
export function bodySegmentFor(body: OrganModel, organId: string): number {
  if (!organId) return -1;
  return body.segments.findIndex(s => s.drillDown === organId);
}

/**
 * `organs` ordered by where each sits on the body, highest first. Organs the
 * body figure does not place keep their given order after the placed ones.
 * Listing the cards this way keeps the lines from each organ on the body to its
 * card from crossing.
 */
export function organsTopToBottom(body: OrganModel, organs: readonly string[]): string[] {
  const placed: { id: string; y: number; at: number }[] = [];
  const unplaced: string[] = [];
  organs.forEach((id, at) => {
    const s = bodySegmentFor(body, id);
    if (s < 0) {
      unplaced.push(id);
      return;
    }
    const [, y0, , y1] = pathBounds(body.segments[s].path);
    placed.push({ id, y: (y0 + y1) / 2, at });
  });
  placed.sort((a, b) => a.y - b.y || a.at - b.at);
  return [...placed.map(p => p.id), ...unplaced];
}

export function organLabel(registry: OrganRegistry, organ: string): string {
  return registry.get(organ)?.label ?? organ;
}
