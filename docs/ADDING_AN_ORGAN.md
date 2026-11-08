# Adding an organ to the anatomy view

The segmented anatomy view (side panel → **Anatomy**, or the **Anatomy** mode of
the foreground inset) draws an organ divided into named regions. It shades
each region by the share of cells that come from it, and selects those cells
when a region is clicked. Organs are **data**. The viewer ships five — whole
body, heart, brain, liver and pancreas — and adding a sixth means one new file
and one line. No view, matching, statistics or selection code changes.

## 1. Write the model

Create `packages/core/src/anatomy/models/<organ>.ts`:

```ts
import type { OrganModel } from '../types';

export const kidney: OrganModel = {
  id: 'kidney',
  label: 'Kidney',
  view: 'coronal section',
  viewBox: [0, 0, 200, 240],
  // Fields to prefer when several match equally well.
  fieldHints: ['anatomical_region', 'region', 'kidney_region'],
  // Names of the organ itself. Needed whenever a region name also exists in
  // another organ — the brainstem has a medulla too.
  organAliases: ['kidney', 'renal'],
  segments: [
    {
      id: 'cortex',
      label: 'Renal cortex',
      aliases: ['cortex', 'renal cortex', 'kidney cortex'],
      path: 'M…Z'
    },
    { id: 'medulla', label: 'Renal medulla', aliases: ['medulla', 'renal medulla', 'renal pyramid'], path: 'M…Z' },
    { id: 'pelvis', label: 'Renal pelvis', aliases: ['renal pelvis', 'pelvis'], path: 'M…Z' }
  ],
  decor: [{ kind: 'vessel', path: 'M…' }]
};
```

| field | meaning |
|---|---|
| `organAliases` | Names of the organ as a whole (`kidney`, `renal`), not of its regions. Set it on every single-organ model. It does two jobs. First, a qualified label such as `brain: medulla` reaches a region only when the qualifier is one of these names, so the brain's medulla never shades the kidney. Second, the panel uses these names to find the field (usually `tissue`) that says which cells come from this organ, and it counts only those cells. Leave it out only for a model of no single organ, like the whole body. |
| `segments[].path` | SVG path data in the `viewBox`. Several subpaths are fine (both kidneys in the body figure are one segment). |
| `segments[].aliases` | Dataset labels that mean this region. Matching ignores case, punctuation, underscores and accents. It also understands qualified labels (`kidney: renal cortex`) and simple plurals. |
| `segments[].deep` | A structure seen through the surface, such as the hippocampus. It is drawn dashed, on top, and may overlap other segments. |
| `segments[].drillDown` | Set on a body segment to open this organ on double-click. |
| `decor` | Outlines, vessels and surface details. They are never clickable and never counted. |

Colours never go in the model. The view applies the theme and the heat scale.

## 2. Register it

In `packages/core/src/anatomy/models/index.ts`, import the model and append it
to `BUILTIN_MODELS`. To make the body figure open it, set
`drillDown: 'kidney'` on the body's `kidney` segment.

## 3. Test it

```bash
npx vitest run packages/core/test/anatomy.test.ts
```

The suite runs over every registered model, and the tests that list the
built-in organs read `BUILTIN_MODELS`, so a new model needs no edits to
existing tests. It rejects:
- duplicate segment ids;
- an alias claimed by two segments;
- malformed path data;
- paths outside the `viewBox`;
- drill-downs to unregistered models.

Add one case asserting that the labels your datasets use match all of the
organ's regions (see the heart and brain cases).

## 4. Look at it

```bash
node scripts/visual-check.mjs --only anatomy   # organ gallery in all four themes
```

Open `test-results/visual/anatomy-gallery-*.png`, or browse to
`http://localhost:5173/anatomy.html` (append `?theme=white`, `grey` or
`yellow`). Each segment is drawn in its own colour, so gaps and mislabelled
regions are obvious.

## 5. Give it data

A dataset lights up the organ when one of its categorical fields has levels
matching the aliases. Typical sources are an `anatomical_region`,
`kidney_region` or `region` column in `adata.obs`. The panel picks the
best-matching field automatically. The **Region field** selector overrides
that choice. `server/simulate.py::simulate_atlas` shows how the synthetic
atlas annotates heart chambers, brain regions, liver lobes and pancreas parts.
