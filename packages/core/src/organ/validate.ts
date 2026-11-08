import { chooseField, matchLevels } from '../anatomy/match';
import type { OrganModel } from '../anatomy/types';
import type { Manifest } from '../data/manifest';

export type IssueLevel = 'error' | 'warning' | 'info';

export interface OrganIssue {
  level: IssueLevel;
  /** Stable short name, so tests and tooling do not match on prose. */
  code: string;
  message: string;
}

/**
 * Facts about the two datasets' files that only a file system can supply. They
 * are null when the check could not run (a file is missing), which is reported
 * rather than assumed to pass.
 */
export interface PairFileFacts {
  /** `cells/ids.npy` is byte-identical in both datasets. */
  idsIdentical: boolean | null;
  /** `cells/rows.npy` (each cell's row in the source file) is byte-identical. */
  rowsIdentical: boolean | null;
  /** The region column's code files are byte-identical in both datasets. */
  regionCodesIdentical: boolean | null;
  /** The trajectory dataset has a `graph.json`. */
  hasGraphFile: boolean | null;
}

export interface OrganPairInput {
  organ: string;
  /** The organ's detailed figure, whose segments the region values must reach. */
  model: OrganModel;
  umap: Manifest | null;
  trajectory: Manifest | null;
  files: PairFileFacts;
}

/** The region column name the documentation asks for. */
export const RECOMMENDED_REGION_FIELD = 'anatomical_region';

const issue = (level: IssueLevel, code: string, message: string): OrganIssue => ({ level, code, message });

/**
 * Checks that an organ's UMAP and trajectory datasets can drive the Organ View.
 *
 * The view selects cells by index in one dataset and applies the same indices
 * in the other, so the two must hold the same cells in the same order. Cell
 * names and source rows are what prove it, which is why they are compared
 * byte for byte rather than trusting equal counts. The region check uses the
 * viewer's own matcher (`chooseField`, `matchLevels`), so it reports what the
 * viewer will do, not what a separate schema says it should.
 *
 * Errors mean the view will break or select the wrong cells. Warnings mean it
 * works but something is probably unintended.
 */
export function validateOrganPair(input: OrganPairInput): OrganIssue[] {
  const out: OrganIssue[] = [];
  const { umap, trajectory, model, files } = input;
  if (!umap) out.push(issue('error', 'missing-umap', 'the UMAP dataset has no readable manifest.json'));
  if (!trajectory) out.push(issue('error', 'missing-trajectory', 'the trajectory dataset has no readable manifest.json'));
  if (!umap || !trajectory) return out;

  if (umap.n !== trajectory.n) {
    out.push(
      issue('error', 'cell-count', `the datasets hold different numbers of cells (${umap.n} and ${trajectory.n}), so they cannot be the same cells`)
    );
  }
  if (!umap.cellIds || !trajectory.cellIds) {
    out.push(
      issue('error', 'no-cell-ids', 'both datasets need cell names (an id column, or obs_names in an .h5ad) so that alignment can be proven')
    );
  } else if (files.idsIdentical === false) {
    out.push(issue('error', 'ids-differ', 'cells/ids.npy differs: the datasets do not list the same cells in the same order'));
  }
  if (files.rowsIdentical === false) {
    out.push(issue('error', 'rows-differ', 'cells/rows.npy differs: the cells come from different source rows'));
  }
  if (umap.cellIds && trajectory.cellIds && (files.idsIdentical === null || files.rowsIdentical === null)) {
    out.push(issue('warning', 'alignment-unchecked', 'the cell id or source row files could not be compared'));
  }

  // The region field is chosen on the UMAP by the viewer's own rule.
  const fields = (m: Manifest): { name: string; levels: string[] }[] =>
    Object.entries(m.categorical).map(([name, spec]) => ({ name, levels: spec.levels }));
  const choice = chooseField(model, fields(umap));
  if (!choice) {
    out.push(
      issue(
        'error',
        'no-region-field',
        `no categorical column has values that name a part of the ${model.label.toLowerCase()} figure (expected a column such as "${RECOMMENDED_REGION_FIELD}")`
      )
    );
  } else {
    if (choice.field !== RECOMMENDED_REGION_FIELD) {
      out.push(
        issue('warning', 'region-field-name', `the region column was found as "${choice.field}"; "${RECOMMENDED_REGION_FIELD}" is the documented name`)
      );
    }
    const levels = umap.categorical[choice.field].levels;
    const unmatched = levels.filter((_, code) => choice.match.levelToSegment[code] < 0);
    if (unmatched.length > 0) {
      out.push(
        issue(
          'warning',
          'unmapped-regions',
          `these "${choice.field}" values match no part of the figure and will not be selectable: ${unmatched.map(l => `"${l}"`).join(', ')}`
        )
      );
    }
    const reached = new Set<number>();
    for (const s of choice.match.levelToSegment) if (s >= 0) reached.add(s);
    const silent = model.segments.filter((seg, i) => !reached.has(i) && !seg.deep).map(seg => seg.id);
    if (silent.length > 0) {
      out.push(issue('info', 'parts-without-data', `these parts of the figure have no cells and will show as "no data": ${silent.join(', ')}`));
    }
    const other = fields(trajectory).find(f => f.name === choice.field);
    if (!other) {
      out.push(issue('error', 'region-field-missing-in-trajectory', `the trajectory dataset has no "${choice.field}" column`));
    } else {
      const same = other.levels.length === levels.length && other.levels.every((l, i) => l === levels[i]);
      if (!same) {
        out.push(
          issue('error', 'region-levels-differ', `"${choice.field}" lists different values, or a different order, in the two datasets, so a code means different regions in each`)
        );
      } else if (matchLevels(model, other.levels).matchedSegments === 0) {
        out.push(issue('error', 'trajectory-regions-unmatched', 'no region value in the trajectory dataset matches the figure'));
      }
    }
    if (files.regionCodesIdentical === false) {
      out.push(
        issue('error', 'region-codes-differ', `"${choice.field}" codes differ between the datasets: the same cell has a different region in each`)
      );
    }
  }

  if (!('pseudotime' in trajectory.numeric)) {
    out.push(issue('error', 'no-pseudotime', 'the trajectory dataset needs a numeric "pseudotime" column, which it is coloured by'));
  }
  if (!trajectory.hasGraph) {
    out.push(issue('error', 'no-graph', 'the trajectory dataset has no principal graph (manifest hasGraph is false)'));
  } else if (files.hasGraphFile === false) {
    out.push(issue('error', 'graph-file-missing', 'manifest says hasGraph but graph.json is missing'));
  }

  const synthetic = [umap, trajectory].filter(m => m.meta?.synthetic === true).length;
  if (synthetic === 1) out.push(issue('warning', 'mixed-synthetic', 'only one of the two datasets is marked synthetic'));
  if (synthetic === 2) out.push(issue('info', 'synthetic', 'both datasets are marked synthetic and the viewer will label them so'));
  return out;
}

/** True when nothing in `issues` is an error. */
export function isUsable(issues: OrganIssue[]): boolean {
  return !issues.some(i => i.level === 'error');
}
