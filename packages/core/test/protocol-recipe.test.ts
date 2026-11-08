import { describe, expect, it } from 'vitest';
import { synthesizeProtocol } from '@core/protocol/synthetic';
import {
  chainSummary,
  RecipeMockAdapter,
  recipeQuestion,
  SYNTHETIC_NOTICE,
  withRecipeContext
} from '@core/protocol/recipe';
import type { ChatAdapter, Turn } from '@core/chat/adapter';
import { handGraph, STAGES } from './helpers/trees';

const tree = synthesizeProtocol(handGraph(), { datasetId: 't', stageLabels: STAGES });
const chain = [0, 2, 3];

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}

describe('chainSummary', () => {
  it('names the path from the stem to the target and says it is synthetic', () => {
    const text = chainSummary(tree, chain);
    expect(text).toMatch(/synthetic demo data/i);
    const at = chain.map(id => text.indexOf(tree.milestones[id].label));
    expect(at.every(i => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain('>');
  });

  it('is empty for an empty chain', () => {
    expect(chainSummary(tree, [])).toBe('');
  });

  it('does not claim to be synthetic when the tree is not', () => {
    const real = { ...tree, synthetic: false };
    expect(chainSummary(real, chain)).not.toMatch(/synthetic demo data/i);
  });
});

describe('recipeQuestion', () => {
  it('puts the path before the question and keeps the question intact', () => {
    const q = recipeQuestion(tree, chain, 'What do I add first?');
    expect(q.endsWith('Question: What do I add first?')).toBe(true);
    expect(q).toContain(tree.milestones[3].label);
  });

  it('is just the question when nothing is traced', () => {
    expect(recipeQuestion(tree, [], '  hello  ')).toBe('hello');
  });

  it('never exceeds the limit, shrinking the path before the question', () => {
    const q = recipeQuestion(tree, chain, 'x'.repeat(600));
    expect(q.length).toBeLessThanOrEqual(700);
    expect(q.endsWith('x'.repeat(600))).toBe(true);
  });

  it('drops the path entirely when the question leaves no room for it', () => {
    const q = recipeQuestion(tree, chain, 'y'.repeat(690));
    expect(q).toBe('y'.repeat(690));
  });

  it('cuts a question that is itself too long', () => {
    expect(recipeQuestion(tree, chain, 'z'.repeat(900), 700)).toHaveLength(700);
    expect(recipeQuestion(tree, [], 'z'.repeat(900), 700)).toHaveLength(700);
  });

  it('honours a different limit', () => {
    expect(recipeQuestion(tree, chain, 'hello', 120).length).toBeLessThanOrEqual(120);
  });
});

describe('withRecipeContext', () => {
  function recorder(): { adapter: ChatAdapter; asked: string[]; ctxs: unknown[] } {
    const asked: string[] = [];
    const ctxs: unknown[] = [];
    const adapter: ChatAdapter = {
      name: 'inner',
      async *send(ctx, question) {
        ctxs.push(ctx);
        asked.push(question);
        yield 'The service says hello.';
      }
    };
    return { adapter, asked, ctxs };
  }

  it('sends the traced path with the question and passes the answer through', async () => {
    const { adapter, asked } = recorder();
    const wrapped = withRecipeContext(adapter, () => ({ tree, chain }));
    const text = await collect(wrapped.send(null, 'How long?', []));
    expect(asked[0]).toContain(tree.milestones[3].label);
    expect(asked[0].endsWith('Question: How long?')).toBe(true);
    expect(text).toContain('The service says hello.');
  });

  it('opens a synthetic tree\'s answers with the synthetic notice', async () => {
    const { adapter } = recorder();
    const text = await collect(withRecipeContext(adapter, () => ({ tree, chain })).send(null, 'q', []));
    expect(text.startsWith(SYNTHETIC_NOTICE)).toBe(true);
  });

  it('adds no notice for a tree that is not synthetic', async () => {
    const { adapter } = recorder();
    const real = { ...tree, synthetic: false };
    const text = await collect(withRecipeContext(adapter, () => ({ tree: real, chain })).send(null, 'q', []));
    expect(text).toBe('The service says hello.');
  });

  it('does not pass the selection on, and keeps the inner name visible', async () => {
    const { adapter, ctxs } = recorder();
    const wrapped = withRecipeContext(adapter, () => ({ tree, chain }));
    expect(wrapped.name).toBe('recipe+inner');
    const history: Turn[] = [{ role: 'user', text: 'earlier' }];
    await collect(wrapped.send({ n: 3 } as never, 'q', history));
    expect(ctxs[0]).toBeNull();
  });

  it('forwards the abort signal and lets errors through', async () => {
    let got: AbortSignal | undefined;
    const failing: ChatAdapter = {
      name: 'bad',
      // eslint-disable-next-line require-yield
      async *send(_c, _q, _h, signal) {
        got = signal;
        throw new Error('service down');
      }
    };
    const ac = new AbortController();
    const wrapped = withRecipeContext(failing, () => ({ tree, chain }));
    await expect(collect(wrapped.send(null, 'q', [], ac.signal))).rejects.toThrow('service down');
    expect(got).toBe(ac.signal);
  });
});

describe('RecipeMockAdapter', () => {
  it('writes a stem-to-target recipe from the milestones, marked synthetic', async () => {
    const adapter = new RecipeMockAdapter(() => ({ tree, chain }));
    const text = await collect(adapter.send(null, 'Give me a recipe', []));
    expect(text.startsWith(SYNTHETIC_NOTICE)).toBe(true);
    let last = -1;
    for (const id of chain) {
      const at = text.indexOf(tree.milestones[id].label);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
    const firstFactor = tree.milestones[chain[1]].factors[0];
    if (firstFactor) expect(text).toContain(firstFactor.name);
  });

  it('is repeatable', async () => {
    const adapter = new RecipeMockAdapter(() => ({ tree, chain }));
    expect(await collect(adapter.send(null, 'a', []))).toBe(await collect(adapter.send(null, 'b', [])));
  });

  it('asks for a milestone when nothing is traced', async () => {
    const adapter = new RecipeMockAdapter(() => ({ tree, chain: [] }));
    const text = await collect(adapter.send(null, 'recipe?', []));
    expect(text).toMatch(/choose|select|click/i);
    expect(text).toContain(SYNTHETIC_NOTICE);
  });

  it('is named so a tooltip can say which backend answered', () => {
    expect(new RecipeMockAdapter(() => ({ tree, chain })).name).toBe('recipe-mock');
  });
});
