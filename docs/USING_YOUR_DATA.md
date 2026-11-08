# Loading your own data

The viewer never computes a dimensionality reduction. It consumes coordinates
that you have already produced with UMAP, t-SNE, or anything else, plus the
per-cell annotations you want to colour and select by.

## From an `.h5ad` (scanpy / AnnData)

```bash
.venv/bin/python -m server.prep --h5ad path/to/cells.h5ad --id mydata --embedding X_umap
```

- `--embedding` names a key in `adata.obsm` holding an `(n, 2)` array. `X_umap`
  and `X_tsne` are the usual ones. A 50-column `X_pca` is **rejected**, with the
  available keys listed in the error — slice it to two columns, or compute a 2D
  embedding first.
- Categorical columns in `adata.obs` become colour-by fields automatically.
  Numeric columns become continuous fields; a column named `pseudotime` is what
  the trajectory view colours by.
- Cell names (`adata.obs_names`, usually barcodes) are kept as the cell ids,
  together with each cell's row number in the file. Clicking a cell shows
  both on its card, so you can find it again in your AnnData.
- A colour-by column with more than 65,535 distinct values is **rejected
  rather than truncated**. A silently wrapped `uint16` code would colour the
  plot with plausible-looking nonsense. Drop such a column or bin it.

### Choosing columns, and what prep fixes for you

- `--obs-fields cell_type,tissue` and `--numeric-fields pseudotime` pick exactly
  which columns to keep (comma- or space-separated), for `.h5ad` and Parquet.
- When columns are auto-detected, a text column with more than 65,535 distinct
  values (`observation_joinid`, for example) is **skipped with a warning**. A
  column you name explicitly still fails loudly.
- Field names are made URL-safe: `percent.mt` becomes `percent_mt` and
  `cell type` becomes `cell_type` (with `_2` added on a clash). The renames are
  printed.
- Cells with a missing or infinite coordinate are dropped, with a count.
  Missing numeric values are kept; colour ranges are computed over finite
  values only.
- Dataset ids must be letters, digits, `_` or `-` (at most 64 characters).
- Rewriting a dataset removes the fields and chunks it no longer has. Its
  manifest `version` changes whenever any byte does, so browsers never mix
  cached chunks from two versions.

## From Parquet

```bash
.venv/bin/python -m server.prep --parquet path/to/cells.parquet --id mydata
```

Requires `x` and `y` columns. A column named `cell_id`, `barcode` or
`obs_names` (the first one present, in that order) becomes the cell ids
rather than a colour-by field; name another one with `--id-column`. Every
other column is classified as categorical or numeric by dtype. Override the
detection with `--obs-fields` / `--numeric-fields` if you want a subset.

## Trajectories

A principal graph is written when one is supplied to `write_tiles(...,
graph=...)`. The format is monocle3-shaped:

```json
{
  "nodes": [[x, y], ...],
  "edges": [[i, j], ...],
  "root": 17,
  "branchPoints": [17, 42, 88],
  "leaves": [3, 9, 55]
}
```

To attach a graph exported from monocle3, write that JSON to
`data/tiles/<id>/graph.json` and set `"hasGraph": true` in the dataset's
`manifest.json`. The viewer merges the edge list into polylines itself, so the
edges can be in any order.

## Anatomy regions

The anatomy panel matches categorical levels to organ regions by name.
- Body: a field such as `tissue` or `organ` with values like `lung`, `liver`
  or `peripheral blood`.
- Heart, brain, liver and pancreas: a field such as `anatomical_region` with
  values like `left ventricle`, `hippocampus`, `liver: caudate lobe` or
  `pancreas: tail`.

Matching ignores case and punctuation, and understands `organ: region`
qualifiers. If the automatic choice is wrong, pick the field in the panel's
**Region field** selector. To add an organ, see
[`ADDING_AN_ORGAN.md`](ADDING_AN_ORGAN.md).

## Chunk size

The default is 250,000 points per chunk, which is what the capacity benchmark
was tuned against. Change it with `--chunk-size`. Smaller chunks make the plot
fill in more smoothly on a slow connection; larger chunks reduce request count.

## Then

Restart the server. The dataset appears in the switcher automatically — the
viewer discovers whatever the tile server lists, so there is nothing to
register in the front end. Open a specific one directly with
`http://localhost:5173/?dataset=mydata`.

## What the browser actually downloads

Per one million cells, with four categorical fields and one numeric field:

| column | bytes |
|---|---:|
| coordinates (`float32` ×2) | 8 MB |
| four categorical codes (`uint16`) | 8 MB |
| one numeric field (`float32`) | 4 MB |
| **total transferred** | **20 MB** |

Colour is derived in the browser, not transferred.
