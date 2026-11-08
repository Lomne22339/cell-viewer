import { afterEach, describe, expect, it, vi } from 'vitest';
import { cellInfoUrl, fetchCellInfo } from '@core/data/cellInfo';

function respond(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cell identity lookup', () => {
  it('asks for the clicked index within the version the page loaded', () => {
    expect(cellInfoUrl('', 'sim1m', 42, 'abc123')).toBe('/api/dataset/sim1m/cell/42?v=abc123');
    expect(cellInfoUrl('http://h:8000', 'sim1m', 0, '')).toBe('http://h:8000/api/dataset/sim1m/cell/0');
  });

  it('returns the source row and name the server reports', async () => {
    respond(200, { index: 7, row: 123456, id: 'AAACCTGAGAAGGCCT-1' });
    expect(await fetchCellInfo('', 'd', 7, 'v')).toEqual({ row: 123456, id: 'AAACCTGAGAAGGCCT-1' });
  });

  it('passes on nulls for tiles written before cell ids existed', async () => {
    respond(200, { index: 7, row: null, id: null });
    expect(await fetchCellInfo('', 'd', 7, 'v')).toEqual({ row: null, id: null });
  });

  it('treats a stale page, a missing route or a malformed answer as unknown, never as another cell', async () => {
    // 409: the dataset was regenerated since the page loaded, so index 7 now
    // names some other cell. 404: an older server without the route.
    for (const [status, body] of [
      [409, { detail: 'dataset changed' }],
      [404, { detail: 'Not Found' }],
      [200, { index: 7, row: 'twelve', id: 5 }]
    ] as const) {
      respond(status, body);
      expect(await fetchCellInfo('', 'd', 7, 'v')).toBeNull();
    }
  });

  it('treats a network failure as unknown rather than throwing into the click handler', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await fetchCellInfo('', 'd', 7, 'v')).toBeNull();
  });

  it('lets an aborted lookup reject, so a newer click can cancel an older one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }));
    await expect(fetchCellInfo('', 'd', 7, 'v')).rejects.toThrow(/aborted/);
  });
});
