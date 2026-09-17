export interface Manifest {
  datasetId: string;
  n: number;
  chunkSize: number;
  chunks: number;
  bounds: [number, number, number, number];
  categorical: Record<string, { levels: string[] }>;
  numeric: Record<string, { min: number; max: number }>;
  hasGraph: boolean;
}

export interface PrincipalGraph {
  nodes: [number, number][];
  edges: [number, number][];
  root: number;
  branchPoints: number[];
  leaves: number[];
}

export function validateManifest(raw: unknown): Manifest {
  const m = raw as Manifest;
  if (!m || typeof m.n !== 'number' || typeof m.chunkSize !== 'number') {
    throw new Error('malformed manifest: missing n or chunkSize');
  }
  if (m.chunks !== Math.ceil(m.n / m.chunkSize)) {
    throw new Error(
      `manifest chunks=${m.chunks} inconsistent with n=${m.n} chunkSize=${m.chunkSize}`
    );
  }
  return m;
}
