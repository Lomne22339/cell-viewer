import type { SelectionContext } from '../context/build';

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Every chat backend implements this and nothing else.
 *
 * The panel talks only to this interface, so an offline mock, a Claude
 * proxy, or something else entirely are interchangeable without the UI
 * knowing which one it has.
 */
export interface ChatAdapter {
  readonly name: string;
  send(
    ctx: SelectionContext | null,
    question: string,
    history: Turn[],
    signal?: AbortSignal
  ): AsyncIterable<string>;
}

export type { SelectionContext };
