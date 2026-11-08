/**
 * Checks the Organ View datasets in a tile folder before they are used.
 *
 *   npx vite-node scripts/check-organ-data.ts [tilesDir] [organ ...]
 *
 * Defaults to `data/tiles` and all three organs. Exits 0 when every checked
 * organ is usable, 1 when any has an error, 2 for bad arguments. The rules live
 * in `packages/core/src/organ/validate.ts`; this file only reads the tile
 * folders and reports.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDefaultRegistry } from '../packages/core/src/anatomy/models';
import { chooseField } from '../packages/core/src/anatomy/match';
import type { Manifest } from '../packages/core/src/data/manifest';
import { ORGAN_VIEW_ORGANS, organDatasetIds } from '../packages/core/src/organ/organs';
import { isUsable, validateOrganPair, type OrganIssue } from '../packages/core/src/organ/validate';

function readManifest(dir: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

/** Whether two files exist and hold the same bytes; null if either is missing. */
function sameFile(a: string, b: string): boolean | null {
  if (!existsSync(a) || !existsSync(b)) return null;
  return readFileSync(a).equals(readFileSync(b));
}

/** Whether every chunk file of a column folder matches in both datasets. */
function sameFolder(a: string, b: string): boolean | null {
  if (!existsSync(a) || !existsSync(b)) return null;
  const names = readdirSync(a).sort();
  const other = readdirSync(b).sort();
  if (names.join() !== other.join()) return false;
  return names.every(n => readFileSync(join(a, n)).equals(readFileSync(join(b, n))));
}

const [dirArg, ...organArgs] = process.argv.slice(2);
const tiles = dirArg ?? 'data/tiles';
const organs = organArgs.length ? organArgs : [...ORGAN_VIEW_ORGANS];
const registry = createDefaultRegistry();

let failed = false;
for (const organ of organs) {
  if (!(ORGAN_VIEW_ORGANS as readonly string[]).includes(organ)) {
    console.error(`unknown organ "${organ}"; expected one of ${ORGAN_VIEW_ORGANS.join(', ')}`);
    process.exit(2);
  }
  const ids = organDatasetIds(organ);
  const uDir = join(tiles, ids.umap);
  const tDir = join(tiles, ids.trajectory);
  const umap = readManifest(uDir);
  const trajectory = readManifest(tDir);
  const model = registry.get(organ)!;
  const region = umap
    ? chooseField(model, Object.entries(umap.categorical).map(([name, s]) => ({ name, levels: s.levels })))?.field
    : undefined;
  const issues: OrganIssue[] = validateOrganPair({
    organ,
    model,
    umap,
    trajectory,
    files: {
      idsIdentical: sameFile(join(uDir, 'cells', 'ids.npy'), join(tDir, 'cells', 'ids.npy')),
      rowsIdentical: sameFile(join(uDir, 'cells', 'rows.npy'), join(tDir, 'cells', 'rows.npy')),
      regionCodesIdentical: region ? sameFolder(join(uDir, 'codes', region), join(tDir, 'codes', region)) : null,
      hasGraphFile: existsSync(join(tDir, 'graph.json'))
    }
  });
  const ok = isUsable(issues);
  failed ||= !ok;
  console.log(`${ok ? 'OK   ' : 'FAIL '}${organ}  (${ids.umap}, ${ids.trajectory})${umap ? `  ${umap.n} cells` : ''}`);
  for (const i of issues) console.log(`  ${i.level.toUpperCase().padEnd(7)} ${i.code}: ${i.message}`);
}
process.exit(failed ? 1 : 0);
