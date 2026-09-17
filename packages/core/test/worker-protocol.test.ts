import { describe, expect, it } from 'vitest';
import { createWorkerState, handleMessage } from '@core/select/worker';

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
