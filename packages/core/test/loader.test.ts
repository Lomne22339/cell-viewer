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
function fakeFetch(url: string, served: Manifest = manifest): Promise<Response> {
  const bin = (a: ArrayBufferView): Promise<Response> =>
    Promise.resolve(new Response(a.buffer as ArrayBuffer, { status: 200 }));
  if (url.endsWith('/manifest')) return Promise.resolve(Response.json(served));
  const m = /\/chunk\/(xy|codes\/\w+|num\/\w+)\/(\d+)(?:\?.*)?$/.exec(url)!;
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

  /** A fetch that fails chunk 1's xy column with `fail(attempt)` until it returns null. */
  function flakyChunk1(fail: (attempt: number) => Promise<Response> | null) {
    const calls: string[] = [];
    let attempt = 0;
    const fetch = vi.fn((u: string) => {
      calls.push(u);
      if (/\/chunk\/xy\/1$/.test(u)) return fail(attempt++) ?? fakeFetch(u);
      return fakeFetch(u);
    });
    return { fetch, calls, chunk1Calls: () => calls.filter(u => /\/chunk\/xy\/1$/.test(u)).length };
  }

  it('does not retry a 4xx response: the request is wrong, not unlucky', async () => {
    const f = flakyChunk1(() => Promise.resolve(new Response(null, { status: 404 })));
    vi.stubGlobal('fetch', f.fetch);
    const s = await loadDataset('http://x', 'unit', { retries: 3, retryDelayMs: 0 });
    expect(f.chunk1Calls()).toBe(1);
    expect(s.failedChunks).toEqual([1]);
    expect(s.loadedCount).toBe(2);
    vi.unstubAllGlobals();
  });

  it('retries a 5xx response and recovers', async () => {
    const f = flakyChunk1(a => (a < 2 ? Promise.resolve(new Response(null, { status: 503 })) : null));
    vi.stubGlobal('fetch', f.fetch);
    const s = await loadDataset('http://x', 'unit', { retries: 3, retryDelayMs: 0 });
    expect(f.chunk1Calls()).toBe(3);
    expect(s.failedChunks).toEqual([]);
    expect(s.loadedCount).toBe(5);
    vi.unstubAllGlobals();
  });

  it('retries a network error and recovers', async () => {
    const f = flakyChunk1(a => (a < 1 ? Promise.reject(new TypeError('Failed to fetch')) : null));
    vi.stubGlobal('fetch', f.fetch);
    const s = await loadDataset('http://x', 'unit', { retries: 1, retryDelayMs: 0 });
    expect(f.chunk1Calls()).toBe(2);
    expect(s.failedChunks).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('retries a failed chunk once more after every other chunk has been tried', async () => {
    // Fails its only in-pool attempt, then succeeds on the final pass.
    const f = flakyChunk1(a => (a < 1 ? Promise.resolve(new Response(null, { status: 500 })) : null));
    vi.stubGlobal('fetch', f.fetch);
    const seen: number[] = [];
    const s = await loadDataset('http://x', 'unit', {
      retries: 0,
      retryDelayMs: 0,
      onChunk: c => seen.push(c)
    });
    expect(f.chunk1Calls()).toBe(2);
    expect(s.failedChunks).toEqual([]);
    expect(s.loadedCount).toBe(5);
    expect(s.isComplete()).toBe(true);
    expect(seen.sort()).toEqual([0, 1, 2]);
    // The second attempt came after the pool had moved on to chunk 2.
    const retry = f.calls.lastIndexOf('http://x/api/dataset/unit/chunk/xy/1');
    expect(f.calls.indexOf('http://x/api/dataset/unit/chunk/xy/2')).toBeLessThan(retry);
    vi.unstubAllGlobals();
  });

  it('gives up on a chunk that still fails on the final pass, after a backoff', async () => {
    const times: number[] = [];
    const f = flakyChunk1(() => {
      times.push(performance.now());
      return Promise.resolve(new Response(null, { status: 502 }));
    });
    vi.stubGlobal('fetch', f.fetch);
    const s = await loadDataset('http://x', 'unit', { retries: 1, retryDelayMs: 10 });
    // Two attempts in the pool (one retry), then exactly one more at the end.
    expect(f.chunk1Calls()).toBe(3);
    expect(s.failedChunks).toEqual([1]);
    // The final attempt waits longer than the in-pool backoff did (10ms, then 20ms).
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(9);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(19);
    vi.unstubAllGlobals();
  });

  it('versions every chunk URL so a re-prepared dataset is never served stale from cache', async () => {
    const versioned = { ...manifest, version: '2026-11-01 a/b' };
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string) => {
      urls.push(u);
      return fakeFetch(u, versioned);
    }));
    const s = await loadDataset('http://x', 'unit');
    expect(s.loadedCount).toBe(5);
    const chunks = urls.filter(u => u.includes('/chunk/'));
    // 3 chunks x (xy + one categorical + one numeric column).
    expect(chunks).toHaveLength(9);
    for (const u of chunks) expect(u.endsWith('?v=2026-11-01%20a%2Fb')).toBe(true);
    expect(urls.find(u => u.endsWith('/manifest'))).toBe('http://x/api/dataset/unit/manifest');
    vi.unstubAllGlobals();
  });

  it('leaves chunk URLs bare when the manifest has no version', async () => {
    for (const served of [manifest, { ...manifest, version: null } as unknown as Manifest]) {
      const urls: string[] = [];
      vi.stubGlobal('fetch', vi.fn((u: string) => {
        urls.push(u);
        return fakeFetch(u, served);
      }));
      await loadDataset('http://x', 'unit');
      expect(urls.some(u => u.includes('?'))).toBe(false);
      vi.unstubAllGlobals();
    }
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
