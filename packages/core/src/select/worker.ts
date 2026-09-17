import { buildGrid, type UniformGrid } from '../index/grid';
import { selectPolygon, selectRect } from './query';

export type QueryShape =
  | { kind: 'poly'; poly: Float64Array }
  | { kind: 'rect'; rect: [number, number, number, number] };

export type WorkerRequest =
  | { type: 'init'; xy: ArrayBufferLike; count: number }
  | { type: 'query'; id: number; shape: QueryShape; count: number };

export type WorkerReply =
  | { type: 'ready' }
  | { type: 'result'; id: number; indices: Uint32Array; ms: number }
  | { type: 'error'; id?: number; message: string };

export interface WorkerState {
  xy: Float32Array | null;
  grid: UniformGrid | null;
  count: number;
}

export function createWorkerState(): WorkerState {
  return { xy: null, grid: null, count: 0 };
}

/**
 * Pure message handler, kept separate from the Worker global so it can be
 * tested in Node. The worker entry below is a thin shim over it.
 */
export function handleMessage(
  state: WorkerState,
  msg: WorkerRequest
): { reply: WorkerReply; transfer: Transferable[] } {
  if (msg.type === 'init') {
    state.xy = new Float32Array(msg.xy);
    state.count = msg.count;
    state.grid = buildGrid(state.xy, msg.count);
    return { reply: { type: 'ready' }, transfer: [] };
  }

  if (!state.xy || !state.grid) {
    return { reply: { type: 'error', id: msg.id, message: 'query before init' }, transfer: [] };
  }

  // A query can name more cells than were sent — the caller is meant to
  // re-send first, but the worker must not read past its own buffer if it
  // does not. Clamp to what is actually here, and rebuild the index if the
  // prefix has grown.
  const available = state.xy.length / 2;
  const count = Math.min(msg.count, available);
  if (count > state.count) {
    state.count = count;
    state.grid = buildGrid(state.xy, count);
  }

  const t0 = performance.now();
  const indices =
    msg.shape.kind === 'poly'
      ? selectPolygon(state.xy, count, msg.shape.poly, state.grid)
      : selectRect(state.xy, count, msg.shape.rect, state.grid);
  const ms = performance.now() - t0;

  return {
    reply: { type: 'result', id: msg.id, indices, ms },
    transfer: [indices.buffer]
  };
}

// Worker entry. The canonical worker check, so importing this module in Node
// (for the protocol tests) or on the main thread is inert.
const scope = globalThis as unknown as { WorkerGlobalScope?: unknown };
const isWorker =
  typeof scope.WorkerGlobalScope !== 'undefined' &&
  globalThis instanceof (scope.WorkerGlobalScope as new () => object);

if (isWorker) {
  const state = createWorkerState();
  (scope as unknown as DedicatedWorkerGlobalScope).onmessage = (
    ev: MessageEvent<WorkerRequest>
  ): void => {
    const self = scope as unknown as DedicatedWorkerGlobalScope;
    try {
      const { reply, transfer } = handleMessage(state, ev.data);
      self.postMessage(reply, transfer);
    } catch (err) {
      self.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err)
      } satisfies WorkerReply);
    }
  };
}
