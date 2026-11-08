/**
 * A clicked cell's identity in the user's own file.
 *
 * The browser only knows a cell by its position in the shuffled chunks, which
 * means nothing outside the viewer. Prep keeps each cell's source row and,
 * when the source has one, its name (`obs_names`, a barcode), and the server
 * answers per index. Fetching on click keeps a million barcode strings out of
 * the page.
 */
export interface CellInfo {
  /** Row number in the file that was prepared; null for older tiles. */
  row: number | null;
  /** The cell's own name; null when the source had none. */
  id: string | null;
}

export function cellInfoUrl(baseUrl: string, datasetId: string, index: number, version: string): string {
  const v = version ? `?v=${encodeURIComponent(version)}` : '';
  return `${baseUrl}/api/dataset/${encodeURIComponent(datasetId)}/cell/${index}${v}`;
}

/**
 * The source row and name of cell `index`, or null when they cannot be known.
 *
 * Null covers every answer that must not be shown as this cell's identity: a
 * 409 (the dataset was regenerated, so the index now names another cell), an
 * older server without the route, a malformed body and a network failure.
 * The card then keeps showing what it already has. Only an abort rejects, so
 * the caller can tell "superseded" from "unknown".
 */
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
