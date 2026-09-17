import { describe, expect, it, vi } from 'vitest';
import { loadDataset } from '@core/data/loader';
import type { Manifest } from '@core/data/manifest';

const manifest: Manifest = {
  datasetId: 'unit',
  n: 5,
  chunkSize: 2,
  chunks: 3,
  bounds: [0, 0, 10, 10],
  categorical: { cell_type: { levels: ['A', 'B'] } },
  numeric: { pseudotime: { min: 0, max: 1 } },
  hasGraph: false
};

// Chunk c holds points (c*2 + k), each at coordinate (i, i*10).
function fakeFetch(url: string): Promise<Response> {
  const bin = (a: ArrayBufferView): Promise<Response> =>
    Promise.resolve(new Response(a.buffer as ArrayBuffer, { status: 200 }));
  if (url.endsWith('/manifest')) return Promise.resolve(Response.json(manifest));
  const m = /\/chunk\/(xy|codes\/\w+|num\/\w+)\/(\d+)$/.exec(url)!;
  const c = Number(m[2]);
  const start = c * 2;
  const count = Math.min(2, 5 - start);
  const ids = Array.from({ length: count }, (_, k) => start + k);
  if (m[1] === 'xy') return bin(Float32Array.from(ids.flatMap(i => [i + 1, (i + 1) * 10])));
  if (m[1].startsWith('codes')) return bin(Uint16Array.from(ids.map(i => i % 2)));
  return bin(Float32Array.from(ids.map(i => i / 10)));
}

describe('loadDataset', () => {
  it('places every chunk at its correct global offset', async () => {
    vi.stubGlobal('fetch', vi.fn((u: string) => fakeFetch(u)));
    const s = await loadDataset('http://x', 'unit');
    expect(Array.from(s.xy)).toEqual([1, 10, 2, 20, 3, 30, 4, 40, 5, 50]);
    expect(Array.from(s.codes.get('cell_type')!)).toEqual([0, 1, 0, 1, 0]);
    expect(Array.from(s.numeric.get('pseudotime')!)).toEqual([0, 0.1, 0.2, 0.3, 0.4].map(v =>
      Math.fround(v)
    ));
    expect(s.loadedCount).toBe(5);
    expect(s.failedChunks).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('reports progress per chunk so the UI can draw partial data', async () => {
    vi.stubGlobal('fetch', vi.fn((u: string) => fakeFetch(u)));
    const seen: number[] = [];
    const s = await loadDataset('http://x', 'unit', {
      onChunk: (_c, store) => seen.push(store.loadedCount)
    });
    expect(seen).toHaveLength(3);
    // The prefix only ever grows, and it ends at the full dataset.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen.at(-1)).toBe(5);
    expect(s.loadedCount).toBe(5);
    expect(s.isComplete()).toBe(true);
    vi.unstubAllGlobals();
  });

  it('never counts a chunk as loaded before the ones in front of it', async () => {
    // Chunk 0 resolves last, so a byte-counting loader would report cells as
    // ready while chunk 0's slots were still zeroed.
    vi.stubGlobal(
      'fetch',
      vi.fn((u: string) => {
        const m = /\/chunk\/xy\/(\d+)$/.exec(u);
        if (m && m[1] === '0') {
          return new Promise<Response>(resolve => {
            setTimeout(() => void fakeFetch(u).then(resolve), 30);
          });
        }
        return fakeFetch(u);
      })
    );
    const seen: number[] = [];
    const s = await loadDataset('http://x', 'unit', {
      onChunk: (_c, store) => seen.push(store.loadedCount)
    });
    // Until chunk 0 lands the prefix must stay at zero, however many later
    // chunks have already arrived.
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(5);
    vi.unstubAllGlobals();
  });

  it('holds the prefix behind a permanently failed chunk', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((u: string) =>
        /\/chunk\/xy\/1$/.test(u)
          ? Promise.resolve(new Response(null, { status: 500 }))
          : fakeFetch(u)
      )
    );
    const s = await loadDataset('http://x', 'unit', { retries: 0 });
    // Chunk 2 loaded, but chunk 1 did not, so only chunk 0 is safe to use.
    expect(s.failedChunks).toEqual([1]);
    expect(s.loadedChunks).toBe(2);
    expect(s.loadedCount).toBe(2);
    expect(s.isComplete()).toBe(false);
    // Nothing inside the prefix may be an unwritten slot.
    for (let i = 0; i < s.loadedCount; i++) {
      expect(s.xy[i * 2] !== 0 || s.xy[i * 2 + 1] !== 0).toBe(true);
    }
    vi.unstubAllGlobals();
  });

  it('keeps successfully loaded chunks when one chunk fails permanently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((u: string) =>
        /\/chunk\/xy\/1$/.test(u)
          ? Promise.resolve(new Response(null, { status: 500 }))
          : fakeFetch(u)
      )
    );
    const s = await loadDataset('http://x', 'unit', { retries: 0 });
    expect(s.failedChunks).toEqual([1]);
    expect(Array.from(s.xy.slice(0, 4))).toEqual([1, 10, 2, 20]);
    vi.unstubAllGlobals();
  });

  it('rejects a manifest whose chunk count contradicts n', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ ...manifest, chunks: 9 })))
    );
    await expect(loadDataset('http://x', 'unit')).rejects.toThrow(/inconsistent/);
    vi.unstubAllGlobals();
  });
});
