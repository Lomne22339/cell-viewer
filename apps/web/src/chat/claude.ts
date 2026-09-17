import type { SelectionContext } from '@core/context/build';
import type { ChatAdapter, Turn } from '@core/chat/adapter';

/**
 * Talks to the server proxy, which holds the API key. Nothing in this file
 * knows a credential, and nothing here should ever learn one.
 */
export class ClaudeAdapter implements ChatAdapter {
  readonly name = 'claude';

  constructor(private baseUrl: string) {}

  static async isConfigured(baseUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/api/chat/status`);
      return res.ok && (await res.json()).configured === true;
    } catch {
      return false;
    }
  }

  async *send(
    ctx: SelectionContext | null,
    question: string,
    history: Turn[],
    signal?: AbortSignal
  ): AsyncIterable<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, context: ctx, history }),
      signal
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(detail.detail ?? `chat failed: ${res.status}`);
    }
    if (!res.body) throw new Error('chat response had no body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line, and a network chunk can
      // split one, so only complete events are consumed and the tail kept.
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const event of events) {
        const line = event.trim();
        if (!line.startsWith('data: ')) continue;
        const blob = line.slice(6);
        if (blob === '[DONE]') return;
        const parsed = JSON.parse(blob) as { text?: string; error?: string };
        if (parsed.error) throw new Error(parsed.error);
        if (parsed.text) yield parsed.text;
      }
    }
  }
}
