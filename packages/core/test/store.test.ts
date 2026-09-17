import { describe, expect, it, vi } from 'vitest';
import { SelectionStore } from '@core/select/store';

const xy = Float32Array.from([0, 0, 5, 5, 10, 10]);

describe('SelectionStore', () => {
  it('starts empty', () => {
    expect(new SelectionStore(3, xy).current).toBeNull();
  });

  it('notifies subscribers once per change', () => {
    const s = new SelectionStore(3, xy);
    const fn = vi.fn();
    s.subscribe(fn);
    s.set(Uint32Array.from([0, 1]), 'rect');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].indices.length).toBe(2);
  });

  it('derives a mask and a bbox from the selection', () => {
    const s = new SelectionStore(3, xy);
    s.set(Uint32Array.from([0, 1]), 'rect');
    expect(Array.from(s.current!.mask)).toEqual([1, 1, 0]);
    expect(s.current!.bbox).toEqual([0, 0, 5, 5]);
  });

  it('treats an empty selection as a cleared selection', () => {
    const s = new SelectionStore(3, xy);
    s.set(Uint32Array.from([0]), 'rect');
    s.set(new Uint32Array(0), 'poly');
    expect(s.current).toBeNull();
  });

  it('clear() notifies with null', () => {
    const s = new SelectionStore(3, xy);
    const fn = vi.fn();
    s.set(Uint32Array.from([0]), 'rect');
    s.subscribe(fn);
    s.clear();
    expect(fn).toHaveBeenCalledWith(null);
  });

  it('unsubscribe stops delivery', () => {
    const s = new SelectionStore(3, xy);
    const fn = vi.fn();
    s.subscribe(fn)();
    s.set(Uint32Array.from([0]), 'rect');
    expect(fn).not.toHaveBeenCalled();
  });

  it('one throwing subscriber does not stop the others', () => {
    const s = new SelectionStore(3, xy);
    const good = vi.fn();
    s.subscribe(() => { throw new Error('boom'); });
    s.subscribe(good);
    expect(() => s.set(Uint32Array.from([0]), 'rect')).not.toThrow();
    expect(good).toHaveBeenCalled();
  });
});

describe('SelectionClient', () => {
  it('sends only the loaded prefix, and re-sends only when it grows', async () => {
    const { SelectionClient } = await import('@core/select/client');
    const sent: { count: number; floats: number }[] = [];
    // A stand-in for the Worker: records what it was asked to hold.
    const fake = {
      onmessage: null as ((ev: MessageEvent<unknown>) => void) | null,
      postMessage(msg: { type: string; xy?: ArrayBufferLike; count?: number }) {
        if (msg.type === 'init') {
          sent.push({ count: msg.count ?? 0, floats: (msg.xy as ArrayBuffer).byteLength / 4 });
          this.onmessage?.({ data: { type: 'ready' } } as MessageEvent<unknown>);
        }
      },
      terminate() {}
    };
    const client = new SelectionClient(fake as unknown as Worker);
    const xy = new Float32Array(1000 * 2); // allocated full size, mostly unwritten

    await client.ensure(xy, 10);
    await client.ensure(xy, 10); // unchanged: must not copy again
    await client.ensure(xy, 40);

    expect(sent.map(s => s.count)).toEqual([10, 40]);
    // 10 cells is 20 floats, not 2000.
    expect(sent[0].floats).toBe(20);
    expect(sent[1].floats).toBe(80);
  });
});
