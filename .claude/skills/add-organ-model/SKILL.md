---
name: add-organ-model
description: Add a new segmented organ (for example kidney, lung or eye) to the Cell Viewer's anatomy view, or edit an existing one. Covers the OrganModel contract, aliases for data matching, registration, tests and visual verification.
---

# Adding an organ model

Organs are data. A model is one TypeScript module exporting an `OrganModel`
(`packages/core/src/anatomy/types.ts`), plus one line in
`packages/core/src/anatomy/models/index.ts`. Nothing else changes: the panel
tabs, matching, shading, selection and drill-down all read the registry.

## 1. Write the model — `packages/core/src/anatomy/models/<organ>.ts`

```ts
import type { OrganModel } from '../types';

export const kidney: OrganModel = {
  id: 'kidney',
  label: 'Kidney',
  view: 'coronal section',
  viewBox: [0, 0, 200, 240],
  fieldHints: ['anatomical_region', 'region', 'kidney_region'],
  organAliases: ['kidney', 'renal'],
  segments: [
    { id: 'cortex', label: 'Renal cortex', aliases: ['cortex', 'renal cortex', 'kidney cortex'], path: 'M…Z' },
    { id: 'medulla', label: 'Renal medulla', aliases: ['medulla', 'renal medulla', 'renal pyramid'], path: 'M…Z' },
    { id: 'pelvis', label: 'Renal pelvis', aliases: ['pelvis', 'renal pelvis'], path: 'M…Z' }
  ],
  decor: [{ kind: 'vessel', path: 'M…' }]
};
```

Rules:
- Set `organAliases` (names of the organ itself) on every single-organ model.
  Region names repeat across organs (the kidney and the brainstem both have a
  medulla). Without it, `brain: medulla` would shade the renal medulla, and the
  panel could not find the `tissue` field that limits counts to this organ's
  cells. The test suite fails a single-organ model that leaves it out.
- `id` values are unique within the model. `aliases` are unique across the
  model after normalisation (lower case, punctuation stripped). The matcher
  normalises the dataset's labels the same way, so `Renal_Cortex` matches
  `renal cortex`.
- Use one `path` per segment. Multiple subpaths are fine (both kidneys in the
  body model are one segment).
- `deep: true` marks a structure seen through the surface (the hippocampus in
  the brain). It is drawn dashed and on top.
- `drillDown: '<model id>'` on a body segment links to the detailed organ.
- Colours never go in the model. The view applies the theme and the heatmap.

## 2. Register — `packages/core/src/anatomy/models/index.ts`

Add the import and append it to `BUILTIN_MODELS`. If the body figure has a
matching organ, set `drillDown: 'kidney'` on that body segment.

## 3. Test

`npx vitest run packages/core/test/anatomy.test.ts`. The suite iterates every
registered model and checks ids, alias collisions and path syntax, and it
round-trips matching on synthetic levels. The tests that list organs read
`BUILTIN_MODELS`, so they need no edits. Add a case asserting that your
model's expected dataset labels match. The e2e test "ships body, heart,
brain, liver and pancreas figures" checks that those five tabs come first, so
append new organs rather than inserting them.

## 4. Data

For a dataset to light up the new organ, it needs a categorical field whose
levels match the aliases. Typical sources are `anatomical_region` or
`kidney_region` in `adata.obs`. The synthetic `atlas` generator
(`server/simulate.py::simulate_atlas`) shows the pattern.

## 5. Look at it

Run `node scripts/visual-check.mjs --only anatomy` and Read the PNGs. Check
the silhouette reads at 260 px, segments meet without gaps, and labels are
legible on all four themes.
