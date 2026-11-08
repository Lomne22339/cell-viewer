import type { SelectionContext } from '@core/context/build';
import type { ChatAdapter, Turn } from '@core/chat/adapter';
import { chatPanelView, type ChatPanelOptions } from '@core/chat/panelState';
import { esc } from '../ui/escape';

/**
 * The chat panel holds no selection state of its own; it is handed a context
 * whenever the selection changes and keeps only the conversation.
 *
 * Message bodies are set with textContent, never innerHTML: they contain a
 * model's output and a user's typing, neither of which should be able to
 * inject markup into the page.
 *
 * With no options it is the selection chat: locked until cells are selected.
 * `options` lets another chatbot reuse the panel under its own title and
 * placeholder, with or without the selection requirement; the rules are in
 * `chatPanelView` so they can be tested without a DOM.
 */
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
    private adapter: ChatAdapter,
    private options: ChatPanelOptions = {}
  ) {
    const box = document.createElement('div');
    box.className = 'chat';
    box.innerHTML = `
      <div class="chat-head">${esc(chatPanelView(options, null, false).title)}
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
    this.applyView();

    this.sendBtn.addEventListener('click', () => void this.ask());
    this.input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        void this.ask();
      }
    });
  }

  /** Called by the view whenever the selection changes. */
  setContext(ctx: SelectionContext | null): void {
    this.ctx = ctx;
    this.applyView();
  }

  /** Shows what `chatPanelView` says for the current selection and busy state. */
  private applyView(): void {
    const view = chatPanelView(this.options, this.ctx, this.inFlight !== null);
    this.input.disabled = view.inputDisabled;
    // A new selection must not re-enable Ask while an answer is still streaming.
    this.sendBtn.disabled = view.sendDisabled;
    this.input.placeholder = view.placeholder;
    this.badge.hidden = view.badge === null;
    if (view.badge !== null) this.badge.textContent = view.badge;
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
      // Insert the answer right after its own question, wherever later turns
      // have landed in the meantime.
      this.history.splice(this.history.indexOf(turn) + 1, 0, { role: 'assistant', text: answer });
    } catch (err) {
      bubble.remove();
      // Remove exactly this question, not whatever happens to be last: a
      // second question may already have been pushed after it.
      const at = this.history.indexOf(turn);
      if (at >= 0) this.history.splice(at, 1);
      // Asking a second question aborts the first. That is the user's own
      // doing, so it must not surface as a failure.
      if (!ac.signal.aborted) {
        this.append(
          'error',
          `Request failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } finally {
      // Only the request that is still current may release the panel; a
      // superseded one finishing late must not clear the newer one's handle.
      if (this.inFlight === ac) {
        this.inFlight = null;
        this.applyView();
      }
    }
  }

  destroy(): void {
    this.inFlight?.abort();
  }
}
