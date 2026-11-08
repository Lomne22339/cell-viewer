import type { SelectionContext } from '../context/build';
import type { ChatAdapter, Turn } from './adapter';

/** What the server says about the chatbot service; never an address or an id. */
export interface ChatbotStatus {
  configured: boolean;
  ready: boolean;
  reason: string;
}

type FetchLike = typeof fetch;

const MAX_SOURCES_SHOWN = 8;

/**
 * The browser's whole view of the separate chatbot service.
 *
 * It talks only to this server's `/api/chatbot/*` routes. The service address,
 * family and sample id live in the server's environment and never reach the
 * page, so nothing here (or anywhere in the web code) can name them.
 *
 * It is a `ChatAdapter`, so the panel treats it like the mock and the Claude
 * proxy. Two things differ from those and are deliberate:
 *
 * - The service answers with one JSON body, not a stream, so `send` yields the
 *   whole answer once. The panel already copes with a single chunk.
 * - The service's API takes a question and nothing else, so the selection and
 *   the history are accepted (the interface requires them) and ignored.
 *   Selection-aware answers stay on the existing `/api/chat` adapter.
 *
 * `fetchImpl` is injectable so the tests need no network.
 */
export class ServiceAdapter implements ChatAdapter {
  readonly name = 'service';

  constructor(
    private baseUrl: string,
    private fetchImpl: FetchLike = (...args) => fetch(...args)
  ) {}

  /** The server's report on the chatbot, or null if the route fails or answers nonsense. */
  static async status(baseUrl: string, fetchImpl: FetchLike = (...a) => fetch(...a)): Promise<ChatbotStatus | null> {
    try {
      const res = await fetchImpl(`${baseUrl}/api/chatbot/status`);
      if (!res.ok) return null;
      const body: unknown = await res.json();
      if (!body || typeof body !== 'object') return null;
      const { configured, ready, reason } = body as Record<string, unknown>;
      if (typeof configured !== 'boolean' || typeof ready !== 'boolean' || typeof reason !== 'string') return null;
      return { configured, ready, reason };
    } catch {
      return null;
    }
  }

  /** True only when the server says the chatbot is configured and can answer. */
  static async isReady(baseUrl: string, fetchImpl: FetchLike = (...a) => fetch(...a)): Promise<boolean> {
    const status = await ServiceAdapter.status(baseUrl, fetchImpl);
    return status !== null && status.configured && status.ready;
  }

  async *send(
    _ctx: SelectionContext | null,
    question: string,
    _history: Turn[],
    signal?: AbortSignal
  ): AsyncIterable<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/chatbot/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
        signal
      });
    } catch (err) {
      // A superseded question is the user's own doing; the panel recognises
      // the abort, so it must reach the panel unchanged.
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
      throw new Error('The chatbot service could not be reached.');
    }

    if (!res.ok) {
      // The server's own message is not repeated: its status says everything
      // the person needs, and its text is not written for display.
      await res.body?.cancel().catch(() => undefined);
      throw new Error(messageForStatus(res.status));
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error('The chatbot sent an unreadable reply.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('The chatbot sent an unreadable reply.');
    }
    const { answer, blocked, sources } = body as Record<string, unknown>;
    if (typeof answer !== 'string' || answer.trim() === '') {
      throw new Error('The chatbot sent an empty reply.');
    }

    let text = answer;
    if (blocked === true) text += '\n\n(The chatbot service blocked this question.)';
    const cited = formatSources(sources);
    if (cited) text += `\n\n${cited}`;
    yield text;
  }
}

function messageForStatus(status: number): string {
  switch (status) {
    case 503:
      return 'The chatbot is not configured on this server.';
    case 409:
      return "The chatbot's knowledge base has not been built yet.";
    case 422:
      return 'That question cannot be sent. Keep it between 1 and 700 characters.';
    case 502:
      return 'The chatbot service is unavailable.';
    case 504:
      return 'The chatbot service took too long to answer.';
    default:
      return `The chatbot request failed (HTTP ${status}).`;
  }
}

/** "Sources:" and one line per distinct labelled source, or '' if there are none. */
function formatSources(sources: unknown): string {
  if (!Array.isArray(sources)) return '';
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of sources) {
    if (!item || typeof item !== 'object') continue;
    const { source, score } = item as Record<string, unknown>;
    if (typeof source !== 'string' || source === '' || seen.has(source)) continue;
    seen.add(source);
    lines.push(typeof score === 'number' && Number.isFinite(score) ? `- ${source} (${score.toFixed(2)})` : `- ${source}`);
    if (lines.length === MAX_SOURCES_SHOWN) break;
  }
  return lines.length ? `Sources:\n${lines.join('\n')}` : '';
}

/** A sentence about why the chatbot cannot be used, or '' when it can. */
export function describeStatus(status: ChatbotStatus | null): string {
  if (status === null) return 'The chatbot service is unavailable.';
  switch (status.reason) {
    case 'ready':
      return '';
    case 'not_configured':
      return 'The chatbot is not configured on this server.';
    case 'not_built':
      return "The chatbot's knowledge base has not been built yet.";
    case 'bad_reply':
      return 'The chatbot service sent an unexpected reply.';
    default:
      return 'The chatbot service is unavailable.';
  }
}
