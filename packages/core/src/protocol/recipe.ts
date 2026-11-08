import type { ChatAdapter, Turn } from '../chat/adapter';
import type { SelectionContext } from '../context/build';
import type { ProtocolTree } from './types';

/** Shown with every answer built on invented milestones. */
export const SYNTHETIC_NOTICE = 'Synthetic demo data — not an experimental recommendation.';

/** What the recipe chat knows: the tree, and the path from the stem to the chosen milestone. */
export interface RecipeContext {
  tree: ProtocolTree;
  chain: number[];
}

const JOINER = '\n\nQuestion: ';
/** A path squeezed below this many characters says too little to be worth sending. */
const MIN_SUMMARY = 40;

/** One line naming the path from the stem cell to the target, or '' if nothing is traced. */
export function chainSummary(tree: ProtocolTree, chain: number[]): string {
  const names = chain.map(id => tree.milestones[id]?.label).filter((x): x is string => !!x);
  if (names.length === 0) return '';
  return `${tree.synthetic ? '[Synthetic demo data] ' : ''}Path from stem cell to target: ${names.join(' > ')}.`;
}

/**
 * The question as the chatbot service receives it.
 *
 * The service takes one string of at most `max` characters and nothing else,
 * so the traced path travels in front of the user's question. The question is
 * never shortened to make room: the path is cut first, and dropped altogether
 * when too little room is left to say anything useful.
 */
export function recipeQuestion(tree: ProtocolTree, chain: number[], text: string, max = 700): string {
  const question = text.trim();
  const summary = chainSummary(tree, chain);
  if (!summary) return question.slice(0, max);
  const full = summary + JOINER + question;
  if (full.length <= max) return full;
  const room = max - JOINER.length - question.length;
  if (room < MIN_SUMMARY) return question.slice(0, max);
  return summary.slice(0, room - 1).trimEnd() + '…' + JOINER + question;
}

/**
 * Wraps another adapter so each question carries the traced path, and so
 * answers about a synthetic tree open with the synthetic notice. The
 * selection is not passed on: the recipe chat is about a milestone, not cells.
 */
export function withRecipeContext(inner: ChatAdapter, getContext: () => RecipeContext): ChatAdapter {
  return {
    name: `recipe+${inner.name}`,
    async *send(_ctx: SelectionContext | null, question: string, history: Turn[], signal?: AbortSignal) {
      const { tree, chain } = getContext();
      if (tree.synthetic) yield `${SYNTHETIC_NOTICE}\n\n`;
      yield* inner.send(null, recipeQuestion(tree, chain, question), history, signal);
    }
  };
}

/**
 * The offline recipe chat: lists the traced milestones with their invented
 * factors and markers. It exists so the panel works with no service
 * configured, and it says plainly that everything in it is made up.
 */
export class RecipeMockAdapter implements ChatAdapter {
  readonly name = 'recipe-mock';

  constructor(private getContext: () => RecipeContext) {}

  // The offline answer depends only on the traced path, not on what was asked.
  async *send(
    _ctx: SelectionContext | null,
    _question: string,
    _history: Turn[],
    _signal?: AbortSignal
  ): AsyncIterable<string> {
    const { tree, chain } = this.getContext();
    if (chain.length === 0) {
      yield `${SYNTHETIC_NOTICE}\n\nClick a milestone on the trajectory map or the pathway graph, or choose a timepoint, and a recipe from the stem cell to it will be listed here.`;
      return;
    }
    const steps = chain.map((id, i) => {
      const m = tree.milestones[id];
      const lines = [`${i + 1}. ${m.label} (day ${m.day}, ${tree.stageLabels[m.stageIndex] ?? 'stage ?'})`];
      if (m.factors.length) lines.push(`   Apply: ${m.factors.map(f => `${f.name} (${f.action})`).join('; ')}`);
      if (m.markers.length) lines.push(`   Check: ${m.markers.join(', ')}`);
      return lines.join('\n');
    });
    yield `${SYNTHETIC_NOTICE}\n\nRecipe from the stem cell to the chosen milestone:\n\n${steps.join('\n')}\n\nEvery name above is invented placeholder data.`;
  }
}
