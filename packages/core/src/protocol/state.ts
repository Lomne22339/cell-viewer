import { chainTo, heaviestLeaf, milestoneAtTime, stageTime, subtreeWeights } from './trace';
import type { ProtocolTree } from './types';

export interface ProtocolSnapshot {
  /** The milestone last clicked, if any. */
  clicked: number | null;
  /** The timepoint (stage index) chosen, if any. */
  stage: number | null;
  /** The fate whose lineage a timepoint slides along. */
  lineageLeaf: number;
  /** Stem to `lineageLeaf`. */
  lineage: number[];
  /** The milestone being traced to, if anything is chosen. */
  target: number | null;
  /** Stem to `target`; empty when nothing is chosen. */
  traced: number[];
  /** Position in `traced` of the step being looked at, or null. */
  focus: number | null;
}

type Listener = (snapshot: ProtocolSnapshot) => void;

/**
 * What the three panels agree on: which milestone is chosen, which timepoint,
 * and which step of the path is in focus.
 *
 * A click picks a lineage; a timepoint slides along it. With no click the
 * lineage is the fate with the most cells, so choosing a timepoint alone still
 * traces somewhere sensible. Every panel reads this one object and none of
 * them keeps a copy, which is what keeps the map, the tree and the chat on the
 * same milestone.
 */
export class ProtocolState {
  private clicked: number | null = null;
  private stage: number | null = null;
  private focusAt: number | null = null;
  private listeners = new Set<Listener>();
  private subtree: number[];
  private defaultLeaf: number;

  /** `leafWeights`: cells per milestone (own, not cumulative). */
  constructor(
    readonly tree: ProtocolTree,
    leafWeights: number[]
  ) {
    const own = tree.milestones.map((_, i) => leafWeights[i] ?? 0);
    this.subtree = subtreeWeights(tree, own);
    const root = tree.milestones.find(m => m.parent === null)?.id ?? 0;
    this.defaultLeaf = heaviestLeaf(tree, root, this.subtree);
  }

  snapshot(): ProtocolSnapshot {
    const lineageLeaf = this.clicked !== null ? heaviestLeaf(this.tree, this.clicked, this.subtree) : this.defaultLeaf;
    const lineage = chainTo(this.tree, lineageLeaf);
    const target =
      this.stage !== null
        ? milestoneAtTime(this.tree, lineage, stageTime(this.stage, this.tree.stageLabels.length))
        : this.clicked;
    const traced = target === null ? [] : chainTo(this.tree, target);
    const focus = traced.length === 0 ? null : Math.max(0, Math.min(traced.length - 1, this.focusAt ?? traced.length - 1));
    return { clicked: this.clicked, stage: this.stage, lineageLeaf, lineage, target, traced, focus };
  }

  click(id: number | null): void {
    if (id !== null && !(Number.isInteger(id) && id >= 0 && id < this.tree.milestones.length)) return;
    if (id === this.clicked) return;
    this.clicked = id;
    this.focusAt = null;
    this.emit();
  }

  setStage(stage: number | null): void {
    if (stage !== null && !(Number.isInteger(stage) && stage >= 0 && stage < this.tree.stageLabels.length)) return;
    if (stage === this.stage) return;
    this.stage = stage;
    this.focusAt = null;
    this.emit();
  }

  /** Moves the focus along the traced path: negative toward the stem, positive toward the target. */
  step(delta: number): void {
    if (!Number.isFinite(delta)) return;
    const before = this.snapshot();
    if (before.focus === null) return;
    const next = Math.max(0, Math.min(before.traced.length - 1, before.focus + Math.trunc(delta)));
    if (next === before.focus) return;
    this.focusAt = next;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }
}
