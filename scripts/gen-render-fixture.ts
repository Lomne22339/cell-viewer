/**
 * Regenerates packages/core/test/fixtures/render-context.json, the golden
 * cases that pin the TypeScript and Python selection renderers to identical
 * text. Run after changing either renderer on purpose:
 *
 *   npx vite-node scripts/gen-render-fixture.ts packages/core/test/fixtures/render-context.json
 *
 * then review the diff and make the other renderer match.
 */
import { writeFileSync } from 'node:fs';
import { renderContextAsText } from '../packages/core/src/chat/mock.ts';

const base = {
  datasetId: 'sim1m', view: 'embedding', n: 12843, totalN: 1000000,
  bbox: [-4, -2, 6, 9], centroid: [1, 3],
  breakdown: {
    cell_type: { 'T cell': 8000, Monocyte: 4843 },
    tissue: { lung: 12000, liver: 843 }
  },
  omittedLevels: {},
  numericStats: { pseudotime: { min: 0.1, max: 0.9, mean: 0.44, q: [0.2, 0.4, 0.7] } },
  sampleIds: ['cell_1', 'cell_2'],
  colorBy: 'cell_type',
  visibleN: 1000000,
  hidden: {}
};

const donors50 = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`donor_${String(i).padStart(2, '0')}`, 400 - i * 7]));
const types13 = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`type_${i}`, 10 + (i % 4)]));

const cases: { name: string; context: unknown }[] = [
  { name: 'basic', context: base },
  {
    // Every value here sits exactly on a rounding tie in binary, where
    // toFixed rounds away from zero and Python's format rounds to even.
    name: 'ties',
    context: {
      ...base, n: 16, totalN: 128, visibleN: 128,
      bbox: [0.125, -0.125, 2.5, 0.375], centroid: [0.625, -0.875],
      breakdown: { cell_type: { a: 1, b: 15 } },
      numericStats: { pseudotime: { min: 0.0625, max: 0.9375, mean: 0.4375, q: [0.3125, 0.5, 0.8125] } }
    }
  },
  {
    // (1 / 800) * 100 is exactly 0.125.
    name: 'share-tie',
    context: { ...base, n: 1, totalN: 800, visibleN: 800, breakdown: { cell_type: { x: 1 } }, numericStats: {} }
  },
  {
    // Decimal literals that look like ties but are not in binary: 1.005 is
    // stored just below, 2.675 just below, so both round down in both languages.
    name: 'near-ties',
    context: {
      ...base,
      bbox: [1.005, 2.675, -1.005, 1e-7], centroid: [-0.001, -1e-7],
      numericStats: { score: { min: 1.0005, max: 2.6745, mean: -0.0005, q: [0.0015, 1e-9, -1e-9] } }
    }
  },
  {
    name: 'filtered',
    context: {
      ...base, visibleN: 200000,
      hidden: { cell_type: Array.from({ length: 14 }, (_, i) => `hidden type ${i}`), tissue: [] }
    }
  },
  {
    // A filter can hide everything visible; 0 is a real count, not "missing".
    name: 'filtered-to-zero',
    context: {
      ...base, n: 5, visibleN: 0, hidden: { tissue: ['lung', 'liver'] },
      breakdown: { cell_type: { 'T cell': 3, Monocyte: 2 } }
    }
  },
  {
    name: 'long-tail',
    context: {
      ...base, n: 20000,
      breakdown: { donor: donors50, cell_type: types13 },
      omittedLevels: { donor: 4950 }
    }
  },
  {
    // Equal counts keep their order in the context, and integer-like labels
    // come first in a JS object, which JSON preserves for Python.
    name: 'tie-order',
    context: { ...base, n: 30, breakdown: { cluster: { b: 5, a: 5, c: 7, '10': 5, '2': 5 } } }
  },
  {
    name: 'null-stats',
    context: {
      ...base,
      numericStats: {
        all_null: { min: null, max: null, mean: null, q: [null, null, null] },
        no_quartiles: { min: 1, max: 2, mean: 1.5 },
        short_quartiles: { min: 0, max: 1, mean: 0.5, q: [0.25] },
        missing: null
      }
    }
  },
  {
    name: 'large-counts',
    context: {
      ...base, n: 1234567, totalN: 10000000, visibleN: 10000000,
      bbox: [-123.456, -0.004, 98765.4321, 0.005], centroid: [-12.3456, 7.891],
      breakdown: { tissue: { lung: 1000000, liver: 234567 } },
      sampleIds: Array.from({ length: 12 }, (_, i) => `cell_${i * 1000}`)
    }
  },
  { name: 'no-selection', context: null },
  { name: 'no-selection-empty', context: { ...base, n: 0 } }
];

const out = cases.map(({ name, context }) => {
  // Round-trip so the context is exactly what either side would read.
  const ctx = JSON.parse(JSON.stringify(context));
  return { name, context: ctx, expected: renderContextAsText(ctx) };
});
writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${out.length} cases`);
