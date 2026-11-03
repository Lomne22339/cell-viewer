export interface CellInfo {
  row: number | null;
  id: string | null;
}

export function cellInfoUrl(baseUrl: string, datasetId: string, index: number, version: string): string {
  const v = version ? `?v=${encodeURIComponent(version)}` : '';
  return `${baseUrl}/api/dataset/${encodeURIComponent(datasetId)}/cell/${index}${v}`;
}

/** A cell's source row and name, or null if unknown (409, old server, bad body); only abort rejects. */
export async function fetchCellInfo(
  baseUrl: string,
  datasetId: string,
  index: number,
  version: string,
  signal?: AbortSignal
): Promise<CellInfo | null> {
  let body: unknown;
  try {
    const res = await fetch(cellInfoUrl(baseUrl, datasetId, index, version), { signal });
    if (!res.ok) return null;
    body = await res.json();
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'AbortError') throw err;
    return null;
  }
  const { row, id } = (body ?? {}) as { row?: unknown; id?: unknown };
  const rowOk = row === null || (typeof row === 'number' && Number.isInteger(row) && row >= 0);
  const idOk = id === null || typeof id === 'string';
  if (!rowOk || !idOk) return null;
  return { row: row as number | null, id: id as string | null };
}
