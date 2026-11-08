import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '@core/anatomy/models';
import type { Manifest } from '@core/data/manifest';
import { isUsable, validateOrganPair, type PairFileFacts } from '@core/organ/validate';

const heart = createDefaultRegistry().get('heart')!;
const REGIONS = ['right atrium', 'left atrium', 'right ventricle', 'left ventricle', 'interventricular septum', 'apex'];

function manifest(over: Partial<Manifest> = {}, regions: string[] = REGIONS): Manifest {
  return {
    datasetId: 'x',
    n: 100,
    chunkSize: 250000,
    chunks: 1,
    bounds: [0, 0, 1, 1],
    categorical: { anatomical_region: { levels: regions }, cell_type: { levels: ['a'] } },
    numeric: {},
    hasGraph: false,
    cellIds: true,
    ...over
  };
}
const traj = (over: Partial<Manifest> = {}, regions?: string[]): Manifest =>
  manifest({ numeric: { pseudotime: { min: 0, max: 1 } }, hasGraph: true, ...over }, regions);
const good: PairFileFacts = { idsIdentical: true, rowsIdentical: true, regionCodesIdentical: true, hasGraphFile: true };

const codes = (m: Parameters<typeof validateOrganPair>[0]['umap'], t: Parameters<typeof validateOrganPair>[0]['trajectory'], files = good) =>
  validateOrganPair({ organ: 'heart', model: heart, umap: m, trajectory: t, files }).map(i => i.code);

describe('validateOrganPair', () => {
  it('accepts a matching pair', () => {
    const issues = validateOrganPair({ organ: 'heart', model: heart, umap: manifest(), trajectory: traj(), files: good });
    expect(isUsable(issues)).toBe(true);
    expect(issues.filter(i => i.level !== 'info')).toEqual([]);
  });

  it('reports a missing manifest as an error and stops', () => {
    expect(codes(null, traj())).toEqual(['missing-umap']);
    expect(codes(manifest(), null)).toEqual(['missing-trajectory']);
  });

  it('flags different cell counts', () => {
    expect(codes(manifest(), traj({ n: 99 }))).toContain('cell-count');
  });

  it('flags cells that differ in name or source row, which equal counts would hide', () => {
    expect(codes(manifest(), traj(), { ...good, idsIdentical: false })).toContain('ids-differ');
    expect(codes(manifest(), traj(), { ...good, rowsIdentical: false })).toContain('rows-differ');
  });

  it('needs cell names in both datasets', () => {
    expect(codes(manifest({ cellIds: false }), traj())).toContain('no-cell-ids');
  });

  it('warns rather than passes when the alignment files could not be compared', () => {
    expect(codes(manifest(), traj(), { ...good, idsIdentical: null })).toContain('alignment-unchecked');
  });

  it('errors when no column names a part of the figure', () => {
    const bad = manifest({ categorical: { anatomical_region: { levels: ['zone 1', 'zone 2'] } } });
    expect(codes(bad, traj())).toContain('no-region-field');
  });

  it('warns about region values that reach no part, and lists them', () => {
    const regions = [...REGIONS, 'atrium of mars'];
    const issues = validateOrganPair({ organ: 'heart', model: heart, umap: manifest({}, regions), trajectory: traj({}, regions), files: good });
    const u = issues.find(i => i.code === 'unmapped-regions');
    expect(u?.level).toBe('warning');
    expect(u?.message).toContain('atrium of mars');
    expect(isUsable(issues)).toBe(true);
  });

  it('notes figure parts that no region reaches', () => {
    const few = REGIONS.slice(0, 2);
    const issues = validateOrganPair({ organ: 'heart', model: heart, umap: manifest({}, few), trajectory: traj({}, few), files: good });
    expect(issues.find(i => i.code === 'parts-without-data')?.message).toContain('left_ventricle');
  });

  it('errors when the region column is missing from, or ordered differently in, the trajectory dataset', () => {
    expect(codes(manifest(), traj({ categorical: { cell_type: { levels: ['a'] } } }))).toContain('region-field-missing-in-trajectory');
    expect(codes(manifest(), traj({}, [...REGIONS].reverse()))).toContain('region-levels-differ');
  });

  it('errors when the same cell has a different region code in each dataset', () => {
    expect(codes(manifest(), traj(), { ...good, regionCodesIdentical: false })).toContain('region-codes-differ');
  });

  it('warns when the region column has another name than the documented one', () => {
    const renamed = (m: Manifest): Manifest => ({ ...m, categorical: { region: m.categorical.anatomical_region } });
    expect(codes(renamed(manifest()), renamed(traj()))).toContain('region-field-name');
  });

  it('needs pseudotime and a graph on the trajectory dataset', () => {
    expect(codes(manifest(), traj({ numeric: {} }))).toContain('no-pseudotime');
    expect(codes(manifest(), traj({ hasGraph: false }))).toContain('no-graph');
    expect(codes(manifest(), traj(), { ...good, hasGraphFile: false })).toContain('graph-file-missing');
  });

  it('notes synthetic data and warns when only one dataset says so', () => {
    const both = validateOrganPair({
      organ: 'heart', model: heart, umap: manifest({ meta: { synthetic: true } }), trajectory: traj({ meta: { synthetic: true } }), files: good
    });
    expect(both.map(i => i.code)).toContain('synthetic');
    expect(codes(manifest({ meta: { synthetic: true } }), traj())).toContain('mixed-synthetic');
  });
});
