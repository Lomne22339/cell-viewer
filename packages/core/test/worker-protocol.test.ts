import { describe, expect, it } from 'vitest';
import { createWorkerState, handleMessage, respond, type WorkerRequest } from '@core/select/worker';
import { SelectionClient } from '@core/select/client';

function points(): Float32Array {
  return Float32Array.from([0, 0, 1, 1, 2, 2, 9, 9, 10, 10]);
}

describe('worker protocol', () => {
  it('acknowledges init and builds an index', () => {
    const state = createWorkerState();
    const { reply } = handleMessage(state, { type: 'init', xy: points().buffer, count: 5 });
    expect(reply.type).toBe('ready');
    expect(state.grid).not.toBeNull();
    expect(state.count).toBe(5);
  });

  it('answers a rect query with the correct indices and echoes the id', () => {
    const state = createWorkerState();
    handleMessage(state, { type: 'init', xy: points().buffer, count: 5 });
    const { reply } = handleMessage(state, {
      type: 'query', id: 7, count: 5, shape: { kind: 'rect', rect: [-1, -1, 3, 3] }
    });
    expect(reply.type).toBe('result');
    if (reply.type !== 'result') throw new Error('unreachable');
    expect(reply.id).toBe(7);
    expect(Array.from(reply.indices)).toEqual([0, 1, 2]);
    expect(reply.ms).toBeGreaterThanOrEqual(0);
  });

  it('answers a polygon query', () => {
    const state = createWorkerState();
    handleMessage(state, { type: 'init', xy: points().buffer, count: 5 });
    const { reply } = handleMessage(state, {
      type: 'query', id: 1, count: 5,
      shape: { kind: 'poly', poly: Float64Array.from([8, 8, 11, 8, 11, 11, 8, 11]) }
    });
    if (reply.type !== 'result') throw new Error('unreachable');
    expect(Array.from(reply.indices)).toEqual([3, 4]);
  });

  it('rebuilds the index when the loaded count grows', () => {
    const state = createWorkerState();
    handleMessage(state, { type: 'init', xy: points().buffer, count: 2 });
    const first = state.grid;
    handleMessage(state, {
      type: 'query', id: 1, count: 5, shape: { kind: 'rect', rect: [-1, -1, 11, 11] }
    });
    expect(state.grid).not.toBe(first);
    expect(state.count).toBe(5);
  });

  it('errors clearly if queried before init instead of throwing on null', () => {
    const { reply } = handleMessage(createWorkerState(), {
      type: 'query', id: 3, count: 5, shape: { kind: 'rect', rect: [0, 0, 1, 1] }
    });
    expect(reply.type).toBe('error');
  });

  it('never reads past the coordinates it was actually given', () => {
    // The client sends only the loaded prefix. A query naming more cells than
    // that must be clamped, not allowed to walk off the end of the buffer.
    const state = createWorkerState();
    const prefix = Float32Array.from([0, 0, 1, 1]); // two cells only
    handleMessage(state, { type: 'init', xy: prefix.buffer, count: 2 });
    const { reply } = handleMessage(state, {
      type: 'query', id: 9, count: 5, shape: { kind: 'rect', rect: [-1, -1, 11, 11] }
    });
    if (reply.type !== 'result') throw new Error('unreachable');
    expect(Array.from(reply.indices)).toEqual([0, 1]);
  });

  it('answers a nearest query nearest-first and echoes the id', () => {
    const state = createWorkerState();
    handleMessage(state, { type: 'init', xy: points().buffer, count: 5 });
    const { reply } = handleMessage(state, {
      type: 'nearest', id: 4, count: 5, near: { x: 9.2, y: 9.2, radius: 2, k: 5 }
    });
    if (reply.type !== 'result') throw new Error('unreachable');
    expect(reply.id).toBe(4);
    expect(Array.from(reply.indices)).toEqual([3, 4]);
  });

  it('clamps a nearest query to the coordinates it holds', () => {
    const state = createWorkerState();
    handleMessage(state, { type: 'init', xy: Float32Array.from([0, 0, 1, 1]).buffer, count: 2 });
    const { reply } = handleMessage(state, {
      type: 'nearest', id: 1, count: 9, near: { x: 0, y: 0, radius: 100, k: 10 }
    });
    if (reply.type !== 'result') throw new Error('unreachable');
    expect(Array.from(reply.indices)).toEqual([0, 1]);
  });

  it('transfers the result buffer rather than copying it', () => {
    const state = createWorkerState();
    handleMessage(state, { type: 'init', xy: points().buffer, count: 5 });
    const { reply, transfer } = handleMessage(state, {
      type: 'query', id: 1, count: 5, shape: { kind: 'rect', rect: [-1, -1, 11, 11] }
    });
    if (reply.type !== 'result') throw new Error('unreachable');
    expect(transfer).toContain(reply.indices.buffer);
  });
});

/** A query the handler throws on: a polygon that is not an array. */
const broken = (id: number): WorkerRequest =>
  ({ type: 'query', id, count: 5, shape: { kind: 'poly', poly: null } }) as unknown as WorkerRequest;

describe('worker failures', () => {
  it('answers a request that throws with an error carrying that request’s id', () => {
    const state = createWorkerState();
    respond(state, { type: 'init', xy: points().buffer, count: 5 });
    const { reply, transfer } = respond(state, broken(5));
    expect(reply.type).toBe('error');
    if (reply.type !== 'error') throw new Error('unreachable');
    expect(reply.id).toBe(5);
    expect(reply.message).toMatch(/\w/);
    expect(transfer).toEqual([]);
  });

  it('keeps working after a failed request', () => {
    const state = createWorkerState();
    respond(state, { type: 'init', xy: points().buffer, count: 5 });
    respond(state, broken(1));
    const { reply } = respond(state, {
      type: 'query', id: 2, count: 5, shape: { kind: 'rect', rect: [-1, -1, 3, 3] }
    });
    if (reply.type !== 'result') throw new Error('unreachable');
    expect(reply.id).toBe(2);
    expect(Array.from(reply.indices)).toEqual([0, 1, 2]);
  });

  it('reports a message it cannot read without inventing an id', () => {
    const { reply } = respond(createWorkerState(), null as unknown as WorkerRequest);
    expect(reply.type).toBe('error');
    if (reply.type !== 'error') throw new Error('unreachable');
    expect(reply.id).toBeUndefined();
  });

  it('fails only the request that broke, through the real client', async () => {
    // A stand-in Worker that runs the real protocol asynchronously.
    const state = createWorkerState();
    const fake = {
      onmessage: null as ((ev: MessageEvent) => void) | null,
      postMessage(msg: WorkerRequest): void {
        setTimeout(() => this.onmessage?.({ data: respond(state, msg).reply } as MessageEvent), 0);
      },
      terminate(): void {}
    };
    const client = new SelectionClient(fake as unknown as Worker);
    await client.init(points(), 5);
    const bad = client.query({ kind: 'poly', poly: null as unknown as Float64Array }, 5);
    const good = client.query({ kind: 'rect', rect: [8, 8, 11, 11] }, 5);
    const near = client.nearest({ x: 0, y: 0, radius: 0.5, k: 1 }, 5);
    await expect(bad).rejects.toThrow();
    expect(Array.from(await good)).toEqual([3, 4]);
    expect(Array.from(await near)).toEqual([0]);
  });
});
