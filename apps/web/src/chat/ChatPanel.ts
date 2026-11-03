import type { SelectionContext } from '@core/context/build';
import type { ChatAdapter, Turn } from '@core/chat/adapter';

/** Holds only the conversation. Bodies use textContent, never innerHTML (model output, user text). */
export class ChatPanel {
  private history: Turn[] = [];
  private ctx: SelectionContext | null = null;
  private log: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private badge: HTMLElement;
  private inFlight: AbortController | null = null;

  constructor(
    root: HTMLElement,
    private adapter: ChatAdapter
  ) {
    const box = document.createElement('div');
    box.className = 'chat';
    box.innerHTML = `
      <div class="chat-head">Ask about the selection
        <span class="chat-badge">no selection</span></div>
      <div class="chat-log" role="log" aria-live="polite"></div>
      <div class="chat-input">
        <textarea rows="2" placeholder="Select cells first, then ask a question…" disabled></textarea>
        <button disabled>Ask</button>
      </div>`;
    root.appendChild(box);

    this.log = box.querySelector('.chat-log')!;
    this.input = box.querySelector('textarea')!;
    this.sendBtn = box.querySelector('button')!;
    this.badge = box.querySelector('.chat-badge')!;
    this.badge.title = `adapter: ${adapter.name}`;

    this.sendBtn.addEventListener('click', () => void this.ask());
    this.input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        void this.ask();
      }
    });
  }

  setContext(ctx: SelectionContext | null): void {
    this.ctx = ctx;
    const has = !!ctx && ctx.n > 0;
    this.input.disabled = !has;
    this.sendBtn.disabled = !has || this.inFlight !== null;
    this.input.placeholder = has
      ? 'Ask about these cells…'
      : 'Select cells first, then ask a question…';
    this.badge.textContent = has ? `${ctx!.n.toLocaleString()} cells` : 'no selection';
  }

  private append(role: 'user' | 'assistant' | 'error', text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.textContent = text;
    this.log.appendChild(el);
    this.log.scrollTop = this.log.scrollHeight;
    return el;
  }

  private async ask(): Promise<void> {
    const question = this.input.value.trim();
    if (!question || this.sendBtn.disabled) return;
    this.input.value = '';
    this.append('user', question);
    const turn: Turn = { role: 'user', text: question };
    const prior = this.history.slice();
    this.history.push(turn);

    const bubble = this.append('assistant', '');
    this.sendBtn.disabled = true;
    this.inFlight?.abort();
    const ac = new AbortController();
    this.inFlight = ac;

    let answer = '';
    try {
      const stream = this.adapter.send(this.ctx, question, prior, ac.signal);
      for await (const chunk of stream) {
        if (ac.signal.aborted) break;
        answer += chunk;
        bubble.textContent = answer;
        this.log.scrollTop = this.log.scrollHeight;
      }
      if (ac.signal.aborted) throw new DOMException('superseded', 'AbortError');
      this.history.splice(this.history.indexOf(turn) + 1, 0, { role: 'assistant', text: answer });
    } catch (err) {
      bubble.remove();
      const at = this.history.indexOf(turn);
      if (at >= 0) this.history.splice(at, 1);
      // Asking a second question aborts the first; that is not a failure.
      if (!ac.signal.aborted) {
        this.append(
          'error',
          `Request failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } finally {
      if (this.inFlight === ac) {
        this.inFlight = null;
        this.sendBtn.disabled = !this.ctx || this.ctx.n === 0;
      }
    }
  }

  destroy(): void {
    this.inFlight?.abort();
  }
}
