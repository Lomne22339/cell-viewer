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
- A column with more than 65,535 distinct values (raw barcodes, for example) is
  **rejected rather than truncated**. A silently wrapped `uint16` code would
  colour the plot with plausible-looking nonsense. Drop such a column or bin it.

## From Parquet

```bash
.venv/bin/python -m server.prep --parquet path/to/cells.parquet --id mydata
```

Requires `x` and `y` columns. Every other column is classified as categorical or
numeric by dtype. Override the detection with `dataset_from_parquet(...,
obs_fields=[...], numeric_fields=[...])` if you want a subset.

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
