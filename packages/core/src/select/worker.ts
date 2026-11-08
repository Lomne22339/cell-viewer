import { buildGrid, type UniformGrid } from '../index/grid';
import { nearestPoints, selectPolygon, selectRect } from './query';

export type QueryShape =
  | { kind: 'poly'; poly: Float64Array }
  | { kind: 'rect'; rect: [number, number, number, number] };

export interface NearestQuery {
  x: number;
  y: number;
  /** World units. */
  radius: number;
  k: number;
}

export type WorkerRequest =
  | { type: 'init'; xy: ArrayBufferLike; count: number }
  | { type: 'query'; id: number; shape: QueryShape; count: number }
  | { type: 'nearest'; id: number; near: NearestQuery; count: number };

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
  let indices: Uint32Array;
  if (msg.type === 'nearest') {
    const { x, y, radius, k } = msg.near;
    indices = nearestPoints(state.xy, count, x, y, radius, k, state.grid);
  } else {
    indices =
      msg.shape.kind === 'poly'
        ? selectPolygon(state.xy, count, msg.shape.poly, state.grid)
        : selectRect(state.xy, count, msg.shape.rect, state.grid);
  }
  const ms = performance.now() - t0;

  return {
    reply: { type: 'result', id: msg.id, indices, ms },
    transfer: [indices.buffer]
  };
}

/** The id of a request, if it has one: `init` does not, nor does garbage. */
function requestId(msg: unknown): number | undefined {
  const id = (msg as { id?: unknown } | null)?.id;
  return typeof id === 'number' ? id : undefined;
}

function errorReply(msg: unknown, err: unknown): WorkerReply {
  return { type: 'error', id: requestId(msg), message: err instanceof Error ? err.message : String(err) };
}

/**
 * `handleMessage` that never throws.
 *
 * A request that fails is answered with an error carrying its own id, so the
 * client rejects that one request and every other pending query still
 * resolves. An error without an id makes the client reject everything it is
 * waiting on, which is right for a failed `init` and wrong for one bad lasso.
 */
export function respond(
  state: WorkerState,
  msg: WorkerRequest
): { reply: WorkerReply; transfer: Transferable[] } {
  try {
    return handleMessage(state, msg);
  } catch (err) {
    return { reply: errorReply(msg, err), transfer: [] };
  }
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
    const { reply, transfer } = respond(state, ev.data);
    try {
      self.postMessage(reply, transfer);
    } catch (err) {
      // Posting itself can fail (a buffer that cannot be cloned); that, too,
      // belongs to this request alone.
      self.postMessage(errorReply(ev.data, err));
    }
  };
}
