# Organ View data: handover guide

The Organ View (heart, brain, liver) currently runs on **synthetic** datasets
made by `server/organs.py`. This page says what real data must look like to
replace them, how to build it with the tools in this repository, and how to
check it before opening the viewer. Everything here follows the code that
reads the data (`server/prep.py`, `packages/core/src/data/`,
`packages/core/src/anatomy/match.ts`, `packages/core/src/organ/`); where a
rule is checked automatically, the check is named.

## 1. What the view needs, in one paragraph

For each organ, two datasets that describe **the same cells in the same
order**: a **UMAP** (any 2D embedding) and a **trajectory** (a 2D layout with a
principal graph and a `pseudotime` column). Each cell carries an **anatomical
region** value that names a part of the organ figure. Choosing a part selects
the cells with that region value; because the two datasets are index-aligned,
the same cells light up in both plots.

## 2. File formats you can supply

The viewer never reads your files directly. You convert them to its tile
folders with `python -m server.prep`, which accepts:

| Input | Command | Notes |
|---|---|---|
| AnnData `.h5ad` | `--h5ad file.h5ad --embedding <obsm key>` | cell names are `obs_names`; the embedding must have exactly 2 columns |
| Parquet | `--parquet file.parquet [--id-column cell_id]` | needs `x` and `y` columns; see 3.2 |

Two ways to get a pair: **one `.h5ad` with two embeddings** (for example
`X_umap` and `X_trajectory` in `obsm`), run twice with different
`--embedding`; or **two Parquet files** with identical annotation columns.
Both need the same `--seed` (default 0). General ingest rules are in
[`USING_YOUR_DATA.md`](USING_YOUR_DATA.md).

## 3. The data contract

### 3.1 Dataset ids and directory layout

The viewer looks for exactly these ids; they are fixed in
`packages/core/src/organ/organs.ts` and `server/organs.py` and pinned by a test
on each side.

| Organ | UMAP dataset | Trajectory dataset |
|---|---|---|
| heart | `organ-heart-umap` | `organ-heart-traj` |
| brain | `organ-brain-umap` | `organ-brain-traj` |
| liver | `organ-liver-umap` | `organ-liver-traj` |

Tiles live under `data/tiles/` (or the folder in `TILES_DIR`). `prep` writes
this; you do not create it by hand:

```
data/tiles/organ-heart-traj/
  manifest.json              n, chunk size, bounds, field levels, hasGraph, cellIds, meta, version
  graph.json                 trajectory dataset only
  xy/000.bin                 float32 pairs, one file per 250,000-cell chunk
  codes/<field>/000.bin      uint16 category codes, one folder per categorical field
  num/<field>/000.bin        float32 values, one folder per numeric field
  cells/ids.npy              cell names (in shuffled order)
  cells/rows.npy             each cell's row in your source file
```

An organ appears in the view only when **both** of its datasets are present.

### 3.2 Columns

| Column | UMAP dataset | Trajectory dataset | Type |
|---|---|---|---|
| cell name (`obs_names`, or Parquet `cell_id`) | required | required | unique string per cell |
| 2D coordinates (`obsm` key, or Parquet `x`, `y`) | required (UMAP) | required (trajectory layout) | finite floats |
| `anatomical_region` | required | required, same values | categorical text |
| `pseudotime` | optional | **required** | numeric |
| any other categorical (`cell_type`, `donor`, `stage`, ...) | optional | optional | text, at most 65,535 distinct values |

Notes taken from the loader:

- Parquet recognises the cell-name column `cell_id`, `barcode` or
  `obs_names` (first present), or the one named by `--id-column`.
- Column names are made URL-safe (`cell type` becomes `cell_type`); the renames
  are printed. Name the region column `anatomical_region` to avoid depending on
  detection. The viewer also finds `region`, `heart_region`/`brain_region`/
  `liver_region`, `location`, `dissection`, `roi`, `lobe` and `zone`, and
  warns if it is not `anatomical_region`.
- Cells whose x or y is missing or infinite are **dropped** by `prep`. If the
  two embeddings have different missing cells, the datasets will no longer
  match; remove such cells from both files before running `prep`.
- Do not set `meta.synthetic`. Data written by `prep` from files carries no
  `meta`, so the "Synthetic demo data" label disappears on its own.

### 3.3 Cell identifiers and matching rules

The link between the two plots is **position, not name**: a selection is a list
of row indices and is applied unchanged to the other dataset. So:

1. Both datasets contain the same number of cells.
2. Cell *i* is the same cell in both. Within each source file the rows may be
   in any order, but the two files must list the cells in the **same order**.
3. `prep` shuffles rows with a permutation that depends only on the cell count
   and `--seed`. Two datasets with the same count and the same seed are
   therefore shuffled identically, and stay aligned. Use one seed for both.
4. Cell names must exist in both and be identical in the same positions. They
   are how the check below proves rule 2.
5. `anatomical_region` lists the **same values in the same order** in both
   datasets (the category code means the same region in each).

### 3.4 Anatomical regions and the figure

Region values are matched to figure parts by **name**, case-, accent- and
punctuation-insensitive (`Left_Ventricle`, `left-ventricle` and
`left ventricle` are equal). A value also matches if it is qualified by the
organ: `heart: left ventricle`, `Brain | Cerebellum` and `liver / left lobe`
read as the part after the qualifier. A qualifier naming a different organ
(`lung: left lobe`) never matches the liver. A part matches on its **id**,
**label** or any **alias** below. The first match wins.

**Heart** (`anatomical_region` values to use)

| Part id | Accepted values |
|---|---|
| `right_atrium` | right atrium, ra, atrium dextrum, right atrial |
| `left_atrium` | left atrium, la, atrium sinistrum, left atrial |
| `right_ventricle` | right ventricle, rv, ventriculus dexter, right ventricular |
| `left_ventricle` | left ventricle, lv, ventriculus sinister, left ventricular |
| `septum` | interventricular septum, septum, ivs, ventricular septum, septal |
| `apex` | apex, cardiac apex, heart apex, apex of heart |
| `aorta` | aorta, aortic arch, ascending aorta, aortic root |
| `pulmonary_artery` | pulmonary artery, pulmonary trunk, pa |
| `superior_vena_cava` | superior vena cava, svc, vena cava |

**Brain**

| Part id | Accepted values |
|---|---|
| `frontal_lobe` | frontal lobe, frontal, frontal cortex, prefrontal cortex, pfc, motor cortex |
| `parietal_lobe` | parietal lobe, parietal, parietal cortex, somatosensory cortex |
| `temporal_lobe` | temporal lobe, temporal, temporal cortex, auditory cortex |
| `occipital_lobe` | occipital lobe, occipital, occipital cortex, visual cortex, v1 |
| `cerebellum` | cerebellum, cerebellar cortex, cerebellar |
| `brainstem` | brainstem, brain stem, pons, medulla, medulla oblongata, midbrain |
| `hippocampus` (deep) | hippocampus, hippocampal formation, dentate gyrus, ca1 |
| `thalamus` (deep) | thalamus, thalamic |
| `amygdala` (deep) | amygdala, amygdaloid complex |
| `striatum` (deep) | striatum, basal ganglia, caudate nucleus, putamen, nucleus accumbens |

**Liver**

| Part id | Accepted values |
|---|---|
| `right_lobe` | right lobe, right hepatic lobe, lobus hepatis dexter, right liver lobe |
| `left_lobe` | left lobe, left hepatic lobe, lobus hepatis sinister, left liver lobe |
| `caudate_lobe` | caudate lobe, caudate, lobus caudatus |
| `quadrate_lobe` | quadrate lobe, quadrate, lobus quadratus |
| `gallbladder` | gallbladder, gall bladder, cholecyst |

The tables are copied from `packages/core/src/anatomy/models/{heart,brain,liver}.ts`;
if they ever disagree, the model files are right. Parts with no cells show as
"no data" and are not selectable. A value that matches no part is simply never
selectable (reported as a warning below).

### 3.5 The principal graph (`graph.json`)

Trajectory dataset only. Coordinates are in the trajectory layout's space.

```json
{
  "nodes": [[0.0, 0.0], [4.0, 3.1], [8.0, 4.9]],
  "edges": [[0, 1], [1, 2]],
  "root": 0,
  "branchPoints": [1],
  "leaves": [2]
}
```

`prep --graph graph.json` validates it (every index must be a node, nodes must
be finite) and writes it together with `"hasGraph": true`. A graph exported from
monocle3 only needs converting to this shape.

## 4. Replacing the synthetic datasets

1. Produce the two inputs per organ (section 2) satisfying section 3. A
   runnable, invented example is in
   [`examples/make_organ_example.py`](examples/make_organ_example.py).
2. Back up `data/tiles` if you want to keep the synthetic sets, then build
   (PowerShell shown; use `.venv/bin/python` on Linux and macOS):

   ```powershell
   .\.venv_win\Scripts\python.exe -m server.prep --parquet heart_umap.parquet --id organ-heart-umap --id-column cell_id --seed 0
   .\.venv_win\Scripts\python.exe -m server.prep --parquet heart_traj.parquet --id organ-heart-traj --id-column cell_id --seed 0 --graph heart_graph.json
   ```

   For an `.h5ad`, use `--h5ad cells.h5ad --embedding X_umap` and
   `--embedding X_trajectory` instead, with `--id` as above.
3. Check the pair (section 5). Fix every ERROR.
4. Open `http://localhost:5173/?mode=organ` (reload the page; restart the
   server if the new data does not appear).

Rewriting a dataset replaces the synthetic one in place, removes its old
fields, and changes its `version`, so browsers do not reuse cached chunks.
Do not run `server.prep --organ-size ...` afterwards: it regenerates the
synthetic sets under the same ids.

## 5. Validation

```powershell
npx vite-node scripts/check-organ-data.ts                      # all three organs in data/tiles
npx vite-node scripts/check-organ-data.ts data/tiles heart     # one organ
npx vite-node scripts/check-organ-data.ts C:\path\to\tiles
```

Exit status: 0 usable, 1 an error found, 2 bad arguments. The rules are in
`packages/core/src/organ/validate.ts` and use the viewer's own region matcher,
so the report is what the viewer will do. Tested in
`packages/core/test/organ-validate.test.ts`.

| Level | Code | Meaning |
|---|---|---|
| ERROR | `missing-umap`, `missing-trajectory` | a dataset has no readable `manifest.json` |
| ERROR | `cell-count` | different numbers of cells |
| ERROR | `no-cell-ids` | a dataset has no cell names |
| ERROR | `ids-differ` | cell names differ or are in another order |
| ERROR | `rows-differ` | cells come from different source rows |
| ERROR | `no-region-field` | no column has values that name a part of the figure |
| ERROR | `region-field-missing-in-trajectory`, `region-levels-differ`, `trajectory-regions-unmatched` | the region column is missing, or lists other values or another order in the trajectory dataset |
| ERROR | `region-codes-differ` | the same cell has a different region in the two datasets |
| ERROR | `no-pseudotime`, `no-graph`, `graph-file-missing` | the trajectory dataset lacks `pseudotime` or a valid graph |
| WARNING | `unmapped-regions` | these region values match no part and will not be selectable (listed) |
| WARNING | `region-field-name` | works, but the column is not called `anatomical_region` |
| WARNING | `alignment-unchecked`, `mixed-synthetic` | a comparison could not run, or only one dataset is marked synthetic |
| INFO | `parts-without-data`, `synthetic` | parts that will say "no data" (deep structures are not listed); both datasets labelled synthetic |

Example, a pair with a wrong cell count, a misnamed region and no pseudotime:

```
FAIL heart  (organ-heart-umap, organ-heart-traj)  30000 cells
  ERROR   cell-count: the datasets hold different numbers of cells (30000 and 29999), ...
  ERROR   ids-differ: cells/ids.npy differs: the datasets do not list the same cells ...
  ERROR   region-levels-differ: "anatomical_region" lists different values, ...
  ERROR   no-pseudotime: the trajectory dataset needs a numeric "pseudotime" column, ...
```

## 6. What the synthetic data looks like

`python -m server.prep --sizes --traj-size 0 --organ-size 30000` writes 30,000
cells per organ, using the regions and cell types in `ATLAS_ORGANS`
(`server/simulate.py`): the same fields (`cell_type`, `tissue`,
`anatomical_region`, `donor`, `stage`, numeric `pseudotime`), the same ids and
order in both datasets, `meta = {synthetic: true, organ, kind}` in the
manifests, and an invented principal graph. The checker accepts it, which is
the quickest way to see a passing result. All values are random.

## 7. Known limits

- Only heart, brain and liver are in the view. Adding an organ means a figure
  model (see [`ADDING_AN_ORGAN.md`](ADDING_AN_ORGAN.md)), its entry in
  `ORGAN_VIEW_ORGANS` in both `packages/core/src/organ/organs.ts` and
  `server/organs.py`, and its two datasets.
- Dataset ids are fixed by the table in 3.1; they cannot be renamed by
  configuration.
- `prep` does not yet verify that two separately ingested files are aligned;
  the checker in section 5 is that verification.
