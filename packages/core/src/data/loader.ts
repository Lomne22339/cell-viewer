import { allocateStore, CellStore } from './schema';
import { validateManifest, type Manifest, type PrincipalGraph } from './manifest';

export interface LoadOptions {
  onChunk?: (chunk: number, store: CellStore) => void;
  signal?: AbortSignal;
  /** Concurrent chunk requests. Above ~6 the browser queues them anyway. */
  concurrency?: number;
  retries?: number;
}

async function fetchBuffer(
  url: string,
  retries: number,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.arrayBuffer();
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 150 * 2 ** attempt));
      }
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
 * A chunk that fails after its retries is recorded in `failedChunks` and
 * the rest of the dataset still renders: a partial plot beats a blank one.
 */
export async function loadDataset(
  baseUrl: string,
  id: string,
  opts: LoadOptions = {}
): Promise<CellStore> {
  const { onChunk, signal, concurrency = 6, retries = 3 } = opts;
  const manifest = await fetchManifest(baseUrl, id, signal);
  const store = allocateStore(manifest);
  const base = `${baseUrl}/api/dataset/${id}/chunk`;

  const loadChunk = async (c: number): Promise<void> => {
    const { start, count } = store.chunkRange(c);
    if (count <= 0) return;
    try {
      const jobs: Promise<void>[] = [
        fetchBuffer(`${base}/xy/${c}`, retries, signal).then(buf => {
          store.xy.set(new Float32Array(buf, 0, count * 2), start * 2);
        })
      ];
      for (const field of store.codes.keys()) {
        jobs.push(
          fetchBuffer(`${base}/codes/${field}/${c}`, retries, signal).then(buf => {
            store.codes.get(field)!.set(new Uint16Array(buf, 0, count), start);
          })
        );
      }
      for (const field of store.numeric.keys()) {
        jobs.push(
          fetchBuffer(`${base}/num/${field}/${c}`, retries, signal).then(buf => {
            store.numeric.get(field)!.set(new Float32Array(buf, 0, count), start);
          })
        );
      }
      await Promise.all(jobs);
      // Only now is every column of this chunk written.
      store.markChunkLoaded(c);
    } catch (err) {
      if (signal?.aborted) throw err;
      store.failedChunks.push(c);
      return;
    }
    onChunk?.(c, store);
  };

  // Fixed-size worker pool, in chunk order so the plot fills predictably.
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, manifest.chunks) }, async () => {
    while (next < manifest.chunks) {
      await loadChunk(next++);
    }
  });
  await Promise.all(workers);
  store.failedChunks.sort((a, b) => a - b);
  return store;
}
