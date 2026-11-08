import { describe, expect, it } from 'vitest';
import { ServiceAdapter, describeStatus } from '@core/chat/service';
import type { ChatAdapter } from '@core/chat/adapter';
import type { SelectionContext } from '@core/context/build';

type Call = { url: string; init: RequestInit | undefined };

/** A fetch that records its calls and answers from `respond`. */
function fakeFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}

async function failure(stream: AsyncIterable<string>): Promise<Error> {
  try {
    await collect(stream);
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the stream to fail');
}

const ctx = { n: 5 } as unknown as SelectionContext;

describe('ServiceAdapter.status', () => {
  it('reads /api/chatbot/status and returns what the server says', async () => {
    const { fn, calls } = fakeFetch(() => json({ configured: true, ready: true, reason: 'ready' }));
    const status = await ServiceAdapter.status('', fn);
    expect(status).toEqual({ configured: true, ready: true, reason: 'ready' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/chatbot/status');
    expect(calls[0].init?.method ?? 'GET').toBe('GET');
  });

  it('prefixes a separate API host', async () => {
    const { fn, calls } = fakeFetch(() => json({ configured: false, ready: false, reason: 'not_configured' }));
    await ServiceAdapter.status('http://api.test', fn);
    expect(calls[0].url).toBe('http://api.test/api/chatbot/status');
  });

  it.each([
    ['not configured', { configured: false, ready: false, reason: 'not_configured' }, false],
    ['knowledge base not built', { configured: true, ready: false, reason: 'not_built' }, false],
    ['unreachable', { configured: true, ready: false, reason: 'unreachable' }, false],
    ['ready', { configured: true, ready: true, reason: 'ready' }, true]
  ])('isReady is decided by the server: %s', async (_name, body, expected) => {
    const { fn } = fakeFetch(() => json(body));
    expect(await ServiceAdapter.isReady('', fn)).toBe(expected);
  });

  it('is null, and not ready, when the route fails, is missing or answers nonsense', async () => {
    for (const respond of [
      () => json({ detail: 'boom' }, 500),
      () => json({ detail: 'nope' }, 404),
      () => new Response('<html>', { status: 200 }),
      () => json(['configured']),
      () => json({ configured: 'yes', ready: true, reason: 'ready' }),
      () => json({ configured: true, ready: true })
    ]) {
      const { fn } = fakeFetch(respond);
      expect(await ServiceAdapter.status('', fn)).toBeNull();
      expect(await ServiceAdapter.isReady('', fn)).toBe(false);
    }
  });

  it('is null when the network fails', async () => {
    const { fn } = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await ServiceAdapter.status('', fn)).toBeNull();
    expect(await ServiceAdapter.isReady('', fn)).toBe(false);
  });
});

describe('describeStatus', () => {
  it('words each reason for a person', () => {
    expect(describeStatus({ configured: false, ready: false, reason: 'not_configured' })).toMatch(/not configured/i);
    expect(describeStatus({ configured: true, ready: false, reason: 'unreachable' })).toMatch(/unavailable/i);
    expect(describeStatus({ configured: true, ready: false, reason: 'not_built' })).toMatch(/knowledge base/i);
    expect(describeStatus({ configured: true, ready: false, reason: 'bad_reply' })).toMatch(/unexpected/i);
    expect(describeStatus({ configured: true, ready: true, reason: 'ready' })).toBe('');
  });

  it('treats a missing status as unavailable and an unknown reason as unavailable', () => {
    expect(describeStatus(null)).toMatch(/unavailable/i);
    expect(describeStatus({ configured: true, ready: false, reason: 'something_new' })).toMatch(/unavailable/i);
  });
});

describe('ServiceAdapter.send', () => {
  it('is a ChatAdapter and is named so a tooltip can say which backend answered', () => {
    const adapter: ChatAdapter = new ServiceAdapter('');
    expect(adapter.name).toBe('service');
  });

  it('posts only the question to /api/chatbot/chat, never the selection or history', async () => {
    const { fn, calls } = fakeFetch(() => json({ answer: 'Use Activin A.', blocked: false, sources: [] }));
    const ac = new AbortController();
    const text = await collect(
      new ServiceAdapter('', fn).send(ctx, 'Which factors?', [{ role: 'user', text: 'earlier' }], ac.signal)
    );
    expect(text).toBe('Use Activin A.');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/chatbot/chat');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ question: 'Which factors?' });
    expect((calls[0].init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(calls[0].init?.signal).toBe(ac.signal);
  });

  it('works with no selection', async () => {
    const { fn } = fakeFetch(() => json({ answer: 'ok', blocked: false, sources: [] }));
    expect(await collect(new ServiceAdapter('', fn).send(null, 'hi', []))).toBe('ok');
  });

  it('never calls the existing /api/chat route', async () => {
    const { fn, calls } = fakeFetch(() => json({ answer: 'ok', blocked: false, sources: [] }));
    await collect(new ServiceAdapter('', fn).send(ctx, 'hi', []));
    for (const c of calls) expect(c.url).not.toMatch(/\/api\/chat(\?|$)/);
  });

  it('yields the answer as a single piece, since the reply is not streamed', async () => {
    const { fn } = fakeFetch(() => json({ answer: 'one piece', blocked: false, sources: [] }));
    const pieces: string[] = [];
    for await (const p of new ServiceAdapter('', fn).send(null, 'q', [])) pieces.push(p);
    expect(pieces).toEqual(['one piece']);
  });

  describe('blocked replies and sources', () => {
    it('keeps the answer and says it was blocked', async () => {
      const { fn } = fakeFetch(() => json({ answer: 'Out of scope.', blocked: true, sources: [] }));
      const text = await collect(new ServiceAdapter('', fn).send(null, 'q', []));
      expect(text.startsWith('Out of scope.')).toBe(true);
      expect(text).toMatch(/blocked/i);
    });

    it('lists the labelled sources once each, with their scores', async () => {
      const { fn } = fakeFetch(() =>
        json({
          answer: 'Answer.',
          blocked: false,
          sources: [
            { text: 'a', source: 'protocol.pdf', score: 0.912 },
            { text: 'b', source: 'protocol.pdf', score: 0.5 },
            { text: 'c', source: 'notes.md' },
            { text: 'd' },
            { text: 'e', source: 7 }
          ]
        })
      );
      const text = await collect(new ServiceAdapter('', fn).send(null, 'q', []));
      expect(text.startsWith('Answer.')).toBe(true);
      expect(text).toContain('Sources:');
      expect(text).toContain('protocol.pdf (0.91)');
      expect(text).toContain('notes.md');
      expect(text.match(/protocol\.pdf/g)).toHaveLength(1);
    });

    it('adds nothing when there are no labelled sources', async () => {
      for (const sources of [[], [{ text: 'x' }], undefined, 'junk']) {
        const { fn } = fakeFetch(() => json({ answer: 'Plain.', blocked: false, sources }));
        expect(await collect(new ServiceAdapter('', fn).send(null, 'q', []))).toBe('Plain.');
      }
    });

    it('lists no more than eight sources', async () => {
      const sources = Array.from({ length: 20 }, (_, i) => ({ text: 't', source: `doc_${i}.pdf` }));
      const { fn } = fakeFetch(() => json({ answer: 'A.', blocked: false, sources }));
      const text = await collect(new ServiceAdapter('', fn).send(null, 'q', []));
      expect(text.match(/doc_\d+\.pdf/g)).toHaveLength(8);
    });
  });

  describe('errors', () => {
    const LEAK = 'Expected directory /app/project/x on 192.168.2.228';

    it.each([
      [503, /not configured/i],
      [409, /knowledge base/i],
      [422, /700/],
      [502, /unavailable/i],
      [504, /too long/i],
      [500, /HTTP 500/],
      [404, /HTTP 404/]
    ])('HTTP %i becomes a readable error', async (status, expected) => {
      const { fn } = fakeFetch(() => json({ detail: LEAK }, status));
      const err = await failure(new ServiceAdapter('', fn).send(null, 'q', []));
      expect(err.message).toMatch(expected);
    });

    it('does not repeat whatever the server put in its error body', async () => {
      for (const status of [409, 500, 502, 503, 504]) {
        const { fn } = fakeFetch(() => json({ detail: LEAK }, status));
        const err = await failure(new ServiceAdapter('', fn).send(null, 'q', []));
        expect(err.message).not.toContain('192.168');
        expect(err.message).not.toContain('/app/project');
      }
    });

    it('survives an error body that is not JSON', async () => {
      const { fn } = fakeFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
      const err = await failure(new ServiceAdapter('', fn).send(null, 'q', []));
      expect(err.message).toMatch(/unavailable/i);
    });

    it('reports an unreachable server', async () => {
      const { fn } = fakeFetch(() => {
        throw new TypeError('Failed to fetch');
      });
      const err = await failure(new ServiceAdapter('', fn).send(null, 'q', []));
      expect(err.message).toMatch(/could not be reached/i);
    });

    it('lets an abort through unchanged, so the panel can tell it from a failure', async () => {
      const ac = new AbortController();
      const { fn } = fakeFetch((_url, init) => {
        ac.abort();
        throw new DOMException('aborted', 'AbortError');
      });
      const err = await failure(new ServiceAdapter('', fn).send(null, 'q', [], ac.signal));
      expect(err.name).toBe('AbortError');
    });

    it.each([
      ['not JSON', () => new Response('plain text', { status: 200 })],
      ['an array', () => json(['answer'])],
      ['null', () => json(null)]
    ])('rejects a 200 reply that is %s', async (_name, respond) => {
      const { fn } = fakeFetch(respond);
      const err = await failure(new ServiceAdapter('', fn).send(null, 'q', []));
      expect(err.message).toMatch(/unreadable/i);
    });

    it.each([
      ['missing', {}],
      ['null', { answer: null }],
      ['a number', { answer: 42 }],
      ['empty', { answer: '' }],
      ['blank', { answer: '   ' }]
    ])('rejects a reply whose answer is %s', async (_name, body) => {
      const { fn } = fakeFetch(() => json(body));
      const err = await failure(new ServiceAdapter('', fn).send(null, 'q', []));
      expect(err.message).toMatch(/empty/i);
    });
  });
});
