import type { NearestQuery, QueryShape, WorkerReply } from './worker';

/** Main-thread handle on the selection worker. */
export class SelectionClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: Uint32Array) => void; reject: (e: Error) => void; timed: boolean }
  >();
  private readyPromise: Promise<void>;
  private markReady!: () => void;
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
        const p = this.pending.get(msg.id);
        if (p?.timed) this.lastQueryMs = msg.ms;
        p?.resolve(msg.indices);
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

  init(xy: Float32Array, count: number): Promise<void> {
    // Send only [0, count): xy is allocated at full size and the rest is unwritten.
    const copy = xy.slice(0, Math.max(0, count) * 2);
    this.initializedCount = count;
    this.worker.postMessage({ type: 'init', xy: copy.buffer, count }, [copy.buffer]);
    return this.readyPromise;
  }

  ensure(xy: Float32Array, count: number): Promise<void> {
    if (count === this.initializedCount) return this.readyPromise;
    return this.init(xy, count);
  }

  async query(shape: QueryShape, count: number): Promise<Uint32Array> {
    await this.readyPromise;
    const id = this.nextId++;
    return new Promise<Uint32Array>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, timed: true });
      this.worker.postMessage({ type: 'query', id, shape, count });
    });
  }

  /** Click lookup: cells near a world-space point, nearest first. Point layers are not pickable. */
  async nearest(near: NearestQuery, count: number): Promise<Uint32Array> {
    await this.readyPromise;
    const id = this.nextId++;
    return new Promise<Uint32Array>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, timed: false });
      this.worker.postMessage({ type: 'nearest', id, near, count });
    });
  }

  terminate(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('selection worker terminated'));
    this.pending.clear();
  }
}
