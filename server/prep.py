"""Convert a dataset into pre-shuffled binary chunks the browser can upload
to the GPU without parsing.

Two properties matter and are enforced by tests:
  1. One permutation is applied to every column, so rows stay aligned.
  2. That permutation is uniform, so the first K points of the output are an
     unbiased sample. Level of detail depends entirely on this.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .simulate import PrincipalGraph, SimDataset

MAX_LEVELS = 65_535


def shuffle_dataset(ds: SimDataset, seed: int = 0) -> SimDataset:
    rng = np.random.default_rng(seed)
    perm = rng.permutation(ds.n)
    return SimDataset(
        xy=np.ascontiguousarray(ds.xy[perm]),
        codes={k: np.ascontiguousarray(v[perm]) for k, v in ds.codes.items()},
        levels=dict(ds.levels),
        numeric={k: np.ascontiguousarray(v[perm]) for k, v in ds.numeric.items()},
    )


def _write_column(base: Path, arr: np.ndarray, chunk_size: int, per_row: int) -> None:
    base.mkdir(parents=True, exist_ok=True)
    n = arr.shape[0]
    for c, start in enumerate(range(0, n, chunk_size)):
        stop = min(start + chunk_size, n)
        block = np.ascontiguousarray(arr[start:stop])
        block.tofile(base / f"{c:03d}.bin")
        assert block.size == (stop - start) * per_row


def write_tiles(
    ds: SimDataset,
    out_dir: Path | str,
    dataset_id: str,
    chunk_size: int = 250_000,
    graph: PrincipalGraph | None = None,
    seed: int = 0,
) -> dict:
    out_dir = Path(out_dir)
    root = out_dir / dataset_id
    root.mkdir(parents=True, exist_ok=True)

    sh = shuffle_dataset(ds, seed=seed)
    n = sh.n
    chunks = (n + chunk_size - 1) // chunk_size

    _write_column(root / "xy", sh.xy, chunk_size, per_row=2)
    for field, codes in sh.codes.items():
        _write_column(
            root / "codes" / field, codes.astype(np.uint16, copy=False), chunk_size, per_row=1
        )
    for field, values in sh.numeric.items():
        _write_column(
            root / "num" / field, values.astype(np.float32, copy=False), chunk_size, per_row=1
        )

    pad = 0.02 * max(float(np.ptp(sh.xy[:, 0])), float(np.ptp(sh.xy[:, 1])), 1e-6)
    manifest = {
        "datasetId": dataset_id,
        "n": int(n),
        "chunkSize": int(chunk_size),
        "chunks": int(chunks),
        "bounds": [
            float(sh.xy[:, 0].min()) - pad,
            float(sh.xy[:, 1].min()) - pad,
            float(sh.xy[:, 0].max()) + pad,
            float(sh.xy[:, 1].max()) + pad,
        ],
        "categorical": {f: {"levels": list(sh.levels[f])} for f in sh.codes},
        "numeric": {
            f: {"min": float(v.min()), "max": float(v.max())} for f, v in sh.numeric.items()
        },
        "hasGraph": graph is not None,
    }
    (root / "manifest.json").write_text(json.dumps(manifest))

    if graph is not None:
        (root / "graph.json").write_text(json.dumps({
            "nodes": graph.nodes.astype(float).tolist(),
            "edges": [[int(i), int(j)] for i, j in graph.edges],
            "root": int(graph.root),
            "branchPoints": [int(i) for i in graph.branch_points],
            "leaves": [int(i) for i in graph.leaves],
        }))
    return manifest


def _encode_categorical(values, field: str) -> tuple[np.ndarray, list[str]]:
    """String column to uint16 codes plus a level dictionary.

    A column with more distinct values than uint16 can hold is rejected
    rather than truncated: a silently wrapped barcode column would colour
    the plot with plausible-looking nonsense.
    """
    labels = [str(v) for v in values]
    levels = sorted(set(labels))
    if len(levels) > MAX_LEVELS:
        raise ValueError(
            f"field '{field}' has {len(levels)} distinct values, more than the "
            f"{MAX_LEVELS} a uint16 code can represent; drop it or bin it first"
        )
    index = {label: i for i, label in enumerate(levels)}
    codes = np.fromiter((index[v] for v in labels), dtype=np.uint16, count=len(labels))
    return codes, levels


def dataset_from_h5ad(
    path,
    embedding_key: str = "X_umap",
    obs_fields: list[str] | None = None,
    numeric_fields: list[str] | None = None,
) -> SimDataset:
    import anndata

    adata = anndata.read_h5ad(path)
    if embedding_key not in adata.obsm:
        raise KeyError(
            f"embedding '{embedding_key}' not found; available: {sorted(adata.obsm.keys())}"
        )
    emb = np.asarray(adata.obsm[embedding_key])
    if emb.ndim != 2 or emb.shape[1] != 2:
        raise ValueError(
            f"embedding '{embedding_key}' has shape {emb.shape}; the viewer needs "
            f"exactly 2 columns. Slice it, or compute a 2D UMAP first."
        )
    xy = np.ascontiguousarray(emb[:, :2], dtype=np.float32)

    obs = adata.obs
    # pandas extension dtypes (category in particular) are not valid numpy
    # dtypes, so np.issubdtype raises on them. Ask pandas instead.
    from pandas.api.types import is_numeric_dtype

    if obs_fields is None:
        obs_fields = [c for c in obs.columns if not is_numeric_dtype(obs[c])]
    if numeric_fields is None:
        numeric_fields = [
            c for c in obs.columns if is_numeric_dtype(obs[c]) and c not in obs_fields
        ]

    codes: dict[str, np.ndarray] = {}
    levels: dict[str, list[str]] = {}
    for field_name in obs_fields:
        codes[field_name], levels[field_name] = _encode_categorical(
            obs[field_name].to_numpy(), field_name
        )
    numeric = {
        f: np.ascontiguousarray(obs[f].to_numpy(), dtype=np.float32) for f in numeric_fields
    }
    return SimDataset(xy=xy, codes=codes, levels=levels, numeric=numeric)


def dataset_from_parquet(
    path,
    x: str = "x",
    y: str = "y",
    obs_fields: list[str] | None = None,
    numeric_fields: list[str] | None = None,
) -> SimDataset:
    import pyarrow.parquet as pq

    table = pq.read_table(path)
    cols = table.column_names
    for needed in (x, y):
        if needed not in cols:
            raise KeyError(f"column '{needed}' not in parquet file; available: {cols}")

    xs = np.asarray(table[x].to_numpy(zero_copy_only=False), dtype=np.float32)
    ys = np.asarray(table[y].to_numpy(zero_copy_only=False), dtype=np.float32)
    xy = np.ascontiguousarray(np.stack([xs, ys], axis=1))

    rest = [c for c in cols if c not in (x, y)]
    if obs_fields is None and numeric_fields is None:
        obs_fields, numeric_fields = [], []
        for c in rest:
            arr = table[c].to_numpy(zero_copy_only=False)
            (numeric_fields if np.issubdtype(arr.dtype, np.number) else obs_fields).append(c)
    obs_fields = obs_fields or []
    numeric_fields = numeric_fields or []

    codes: dict[str, np.ndarray] = {}
    levels: dict[str, list[str]] = {}
    for field_name in obs_fields:
        codes[field_name], levels[field_name] = _encode_categorical(
            table[field_name].to_numpy(zero_copy_only=False), field_name
        )
    numeric = {
        f: np.ascontiguousarray(table[f].to_numpy(zero_copy_only=False), dtype=np.float32)
        for f in numeric_fields
    }
    return SimDataset(xy=xy, codes=codes, levels=levels, numeric=numeric)


def _main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Build tile datasets.")
    ap.add_argument("--out", default="data/tiles")
    ap.add_argument("--chunk-size", type=int, default=250_000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--sizes", type=int, nargs="+", default=[100_000, 1_000_000],
                    help="embedding dataset sizes to generate")
    ap.add_argument("--traj-size", type=int, default=500_000)
    ap.add_argument("--h5ad", help="ingest an .h5ad file instead of simulating")
    ap.add_argument("--parquet", help="ingest a Parquet file instead of simulating")
    ap.add_argument("--id", help="dataset id for an ingested file")
    ap.add_argument("--embedding", default="X_umap")
    args = ap.parse_args()

    if args.h5ad or args.parquet:
        if not args.id:
            ap.error("--id is required when ingesting a file")
        ds = (dataset_from_h5ad(args.h5ad, embedding_key=args.embedding)
              if args.h5ad else dataset_from_parquet(args.parquet))
        man = write_tiles(ds, args.out, args.id, args.chunk_size, seed=args.seed)
        print(f"wrote {args.id}: {man['n']} cells, {man['chunks']} chunks, "
              f"fields {sorted(man['categorical'])}")
        return

    from .simulate import simulate_embedding, simulate_trajectory

    def label(n: int) -> str:
        return f"{n // 1_000_000}m" if n >= 1_000_000 else f"{n // 1000}k"

    for n in args.sizes:
        ds = simulate_embedding(n, seed=args.seed)
        man = write_tiles(ds, args.out, f"sim{label(n)}", args.chunk_size, seed=args.seed)
        print(f"wrote sim{label(n)}: {man['n']} cells, {man['chunks']} chunks")

    if args.traj_size:
        ds, g = simulate_trajectory(args.traj_size, seed=args.seed)
        man = write_tiles(ds, args.out, f"traj{label(args.traj_size)}", args.chunk_size,
                          graph=g, seed=args.seed)
        print(f"wrote traj{label(args.traj_size)}: {man['n']} cells, {len(g.edges)} graph edges")


if __name__ == "__main__":
    _main()
