import { allocateStore, CellStore } from './schema';
import { validateManifest, type Manifest, type PrincipalGraph } from './manifest';

export interface LoadOptions {
  onChunk?: (chunk: number, store: CellStore) => void;
  signal?: AbortSignal;
  /** Concurrent chunk requests. Above ~6 the browser queues them anyway. */
  concurrency?: number;
  /** Extra attempts per request after a network error or a 5xx response. */
  retries?: number;
  /** Wait before the first retry; it doubles with each further attempt. */
  retryDelayMs?: number;
}

/** A response that arrived but was not OK. */
class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    url: string
  ) {
    super(`${status} ${url}`);
  }
}

/**
 * A 4xx means the request itself is wrong — a chunk that does not exist, a
 * field the server never wrote — and asking again gets the same answer. Only
 * network errors and 5xx responses are worth another try.
 */
function isPermanent(err: unknown): boolean {
  return err instanceof HttpStatusError && err.status >= 400 && err.status < 500;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function fetchBuffer(
  url: string,
  retries: number,
  retryDelayMs: number,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new HttpStatusError(res.status, url);
      return await res.arrayBuffer();
    } catch (err) {
      if (signal?.aborted || isPermanent(err)) throw err;
      lastError = err;
      if (attempt < retries) await sleep(retryDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function fetchManifest(
  baseUrl: string,
  id: string,
  signal?: AbortSignal
): Promise<Manifest> {
  const res = await fetch(`${baseUrl}/api/dataset/${id}/manifest`, { signal });
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  return validateManifest(await res.json());
}

export async function fetchGraph(
  baseUrl: string,
  id: string,
  signal?: AbortSignal
): Promise<PrincipalGraph> {
  const res = await fetch(`${baseUrl}/api/dataset/${id}/graph`, { signal });
  if (!res.ok) throw new Error(`graph fetch failed: ${res.status}`);
  return (await res.json()) as PrincipalGraph;
}

/**
 * Loads every column chunk into one preallocated set of typed arrays.
 *
 * Chunks are written straight into their final global offset, so a chunk
 * that arrives late never forces earlier data to be copied or re-uploaded.
 *
 * A chunk whose requests fail after their retries is tried once more after
 * every other chunk has been, so a brief outage in the middle of a long load
 * does not cost a chunk for good. If it fails again it is recorded in
 * `failedChunks`. Everything before it still renders, but the chunks after
 * it do not: they are written, yet `loadedCount` cannot advance past the gap
 * (see `CellStore.loadedCount`). A partial plot beats a blank one.
 *
 * When the manifest carries a `version`, it is appended to every chunk URL,
 * so re-preparing a dataset under the same id can never mix freshly written
 * chunks with stale ones from the browser's cache.
 */
export async function loadDataset(
  baseUrl: string,
  id: string,
  opts: LoadOptions = {}
): Promise<CellStore> {
  const { onChunk, signal, concurrency = 6, retries = 3, retryDelayMs = 150 } = opts;
  const manifest = await fetchManifest(baseUrl, id, signal);
  const store = allocateStore(manifest);
  const base = `${baseUrl}/api/dataset/${id}/chunk`;
  const version =
    typeof manifest.version === 'string' && manifest.version !== ''
      ? `?v=${encodeURIComponent(manifest.version)}`
      : '';

  /** Loads one chunk; resolves to the error that stopped it, or null. */
  const loadChunk = async (c: number, tries: number): Promise<unknown> => {
    const { start, count } = store.chunkRange(c);
    if (count <= 0) return null;
    const get = (path: string): Promise<ArrayBuffer> =>
      fetchBuffer(`${base}/${path}/${c}${version}`, tries, retryDelayMs, signal);
    try {
      const jobs: Promise<void>[] = [
        get('xy').then(buf => {
          store.xy.set(new Float32Array(buf, 0, count * 2), start * 2);
        })
      ];
      for (const field of store.codes.keys()) {
        jobs.push(
          get(`codes/${field}`).then(buf => {
            store.codes.get(field)!.set(new Uint16Array(buf, 0, count), start);
          })
        );
      }
      for (const field of store.numeric.keys()) {
        jobs.push(
          get(`num/${field}`).then(buf => {
            store.numeric.get(field)!.set(new Float32Array(buf, 0, count), start);
          })
        );
      }
      await Promise.all(jobs);
      // Only now is every column of this chunk written.
      store.markChunkLoaded(c);
    } catch (err) {
      if (signal?.aborted) throw err;
      return err;
    }
    onChunk?.(c, store);
    return null;
  };

  // Fixed-size worker pool over `chunks`, taken in order so the plot fills
  // from the front.
  const runPool = async (
    chunks: number[],
    tries: number,
    onFail: (c: number, err: unknown) => void
  ): Promise<void> => {
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
      while (next < chunks.length) {
        const c = chunks[next++];
        const err = await loadChunk(c, tries);
        if (err !== null) onFail(c, err);
      }
    });
    await Promise.all(workers);
  };

  const retryLater: number[] = [];
  await runPool(
    Array.from({ length: manifest.chunks }, (_, c) => c),
    retries,
    (c, err) => (isPermanent(err) ? store.failedChunks : retryLater).push(c)
  );
  if (retryLater.length > 0) {
    // One more attempt each, after a pause longer than any in-pool backoff.
    await sleep(retryDelayMs * 2 ** retries);
    retryLater.sort((a, b) => a - b);
    await runPool(retryLater, 0, c => store.failedChunks.push(c));
  }
  store.failedChunks.sort((a, b) => a - b);
  return store;
}
