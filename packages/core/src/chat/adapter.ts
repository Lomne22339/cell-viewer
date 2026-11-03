import type { SelectionContext } from '../context/build';

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

/** The only interface a chat backend implements; the panel never knows which one it has. */
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
