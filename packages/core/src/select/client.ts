import type { QueryShape, WorkerReply } from './worker';

/**
 * Main-thread handle on the selection worker.
 *
 * The coordinate array is copied into the worker once at init. That costs
 * one 8 MB copy per million cells and buys a selection path that never
 * touches the main thread again, so panning stays smooth while a lasso
 * query runs.
 */
export class SelectionClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: Uint32Array) => void; reject: (e: Error) => void }
  >();
  private readyPromise: Promise<void>;
  private markReady!: () => void;
  /** Milliseconds taken by the most recent query, for the benchmark page. */
  lastQueryMs = 0;
  private initializedCount = -1;

  constructor(worker?: Worker) {
    this.worker =
      worker ?? new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.readyPromise = new Promise<void>(res => {
      this.markReady = res;
    });
    this.worker.onmessage = (ev: MessageEvent<WorkerReply>): void => {
      const msg = ev.data;
      if (msg.type === 'ready') {
        this.markReady();
        return;
      }
      if (msg.type === 'result') {
        this.lastQueryMs = msg.ms;
        this.pending.get(msg.id)?.resolve(msg.indices);
        this.pending.delete(msg.id);
        return;
      }
      const err = new Error(msg.message);
      if (msg.id !== undefined) {
        this.pending.get(msg.id)?.reject(err);
        this.pending.delete(msg.id);
      } else {
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      }
    };
  }

  /**
   * Sends a copy of the coordinates; the caller keeps its own array.
   *
   * At ten million cells this copy is eighty megabytes, so it must not happen
   * once per arriving chunk — forty chunks would move three gigabytes for no
   * benefit. `ensure` below is the entry point callers should use; it copies
   * only when the loaded prefix has actually grown since the last time.
   */
  init(xy: Float32Array, count: number): Promise<void> {
    // Only the loaded prefix is worth sending. `xy` is allocated at full size
    // from the start, so copying all of it during the first chunk of a
    // ten-million-cell load would move eighty megabytes of zeroes.
    const copy = xy.slice(0, Math.max(0, count) * 2);
    this.initializedCount = count;
    this.worker.postMessage({ type: 'init', xy: copy.buffer, count }, [copy.buffer]);
    return this.readyPromise;
  }

  /** Re-sends coordinates only if more of them have arrived. */
  ensure(xy: Float32Array, count: number): Promise<void> {
    if (count === this.initializedCount) return this.readyPromise;
    return this.init(xy, count);
  }

  async query(shape: QueryShape, count: number): Promise<Uint32Array> {
    await this.readyPromise;
    const id = this.nextId++;
    return new Promise<Uint32Array>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'query', id, shape, count });
    });
  }

  terminate(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('selection worker terminated'));
    this.pending.clear();
  }
}
