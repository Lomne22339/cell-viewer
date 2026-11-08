"""Convert a dataset into pre-shuffled binary chunks the browser can upload
to the GPU without parsing.

Two properties matter and are enforced by tests:
  1. One permutation is applied to every column, so rows stay aligned.
  2. That permutation is uniform, so the first K points of the output are an
     unbiased sample. Level of detail depends entirely on this.

Before shuffling, `write_tiles` makes the input servable: coordinates become
float32 rows of two, cells without finite coordinates are dropped, and field
names that could not be a URL segment are renamed. Every cell keeps its source
row and, when the source named it, its id, so a cell clicked in the viewer can
be found again in the user's own file. The manifest is strict
JSON, and its `version` changes whenever any written byte does, so chunks can
be cached as immutable under `?v=<version>`.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import os
import sys
from functools import partial
from pathlib import Path
from typing import Callable

import numpy as np

from .names import is_safe, safe_field_names
from .simulate import PrincipalGraph, SimDataset

MAX_LEVELS = 65_535
MAX_ROWS = int(np.iinfo(np.uint32).max)
VERSION_HEX = 16
#: Column names that conventionally hold a cell's own name, in the order a
#: Parquet file is searched for one when no id column is given.
ID_COLUMNS = ("cell_id", "barcode", "obs_names")


class TooManyLevelsError(ValueError):
    """A column has more distinct values than a uint16 code can hold."""

    def __init__(self, field: str, levels: int) -> None:
        super().__init__(
            f"field '{field}' has {levels} distinct values, more than the "
            f"{MAX_LEVELS} a uint16 code can represent; drop it or bin it first"
        )
        self.field = field
        self.levels = levels


def _warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)


def check_dataset_id(dataset_id: str) -> str:
    """The id names a directory and a URL segment, so it must already be
    safe. It is refused rather than slugged: the caller chose it and will
    type it into the viewer, so silently serving it under another name would
    only confuse."""
    if not isinstance(dataset_id, str) or not is_safe(dataset_id):
        raise ValueError(
            f"dataset id {dataset_id!r} is not usable in a URL or a path: use 1 to 64 "
            f"characters from A-Z, a-z, 0-9, '_' and '-'"
        )
    return dataset_id


def _permuted(arr: np.ndarray | None, perm: np.ndarray) -> np.ndarray | None:
    return None if arr is None else np.ascontiguousarray(arr[perm])


def shuffle_dataset(ds: SimDataset, seed: int = 0) -> SimDataset:
    """Every column under one permutation, the cell ids and source rows
    included, so a cell's name stays on the row with its coordinates. Only
    the permutation draws from the generator, so the shuffle for a seed does
    not depend on which optional columns are present."""
    rng = np.random.default_rng(seed)
    perm = rng.permutation(ds.n)
    return SimDataset(
        xy=np.ascontiguousarray(ds.xy[perm]),
        codes={k: np.ascontiguousarray(v[perm]) for k, v in ds.codes.items()},
        levels=dict(ds.levels),
        numeric={k: np.ascontiguousarray(v[perm]) for k, v in ds.numeric.items()},
        ids=_permuted(ds.ids, perm),
        source_rows=_permuted(ds.source_rows, perm),
    )


def _checked_ids(ids, n: int) -> np.ndarray | None:
    if ids is None:
        return None
    ids = np.asarray(ids)
    if ids.shape != (n,):
        raise ValueError(
            f"cell ids have shape {ids.shape}, but there are {n} coordinate rows; "
            f"every cell needs exactly one id"
        )
    return ids


def _utf8(ids: np.ndarray) -> np.ndarray:
    """Cell ids as fixed-width UTF-8 bytes, `S<longest encoded id>`.

    A fixed-width bytes array saves without pickling and loads memory-mapped,
    so the server can read one id without reading them all. Encoding to UTF-8
    rather than keeping NumPy's UTF-32 strings keeps any non-ASCII name intact
    at a quarter of the size for the usual ASCII barcode. Bytes are taken to
    be UTF-8 already. ASCII is valid UTF-8, so an all-ASCII column takes the
    plain cast, which is more than twice as fast, and only a column that
    refuses it pays for the full encode.
    """
    if ids.dtype.kind == "S":
        return ids
    text = ids.astype(np.str_)
    try:
        return text.astype(np.bytes_)
    except UnicodeEncodeError:
        return np.strings.encode(text, "utf-8")


def _servable(ds: SimDataset) -> SimDataset:
    """The dataset as the browser needs it.

    Coordinates are float32 with shape (n, 2): the browser reinterprets the
    bytes as a Float32Array, so float64 input would read as garbage at twice
    the expected length. Every column must be n long, or the mask below and
    the shared permutation would misalign rows. A cell without finite
    coordinates cannot be drawn and would poison the bounds with NaN, so it
    is dropped from every column at once, its id included. Field names become
    URL segments and directories, so unsafe ones are renamed.

    Each kept cell also records its source row, the row it had in the input
    before anything was dropped, which is how a user finds it again in their
    own file when it has no name.
    """
    xy = np.asarray(ds.xy, dtype=np.float32)
    if xy.ndim != 2 or xy.shape[1] != 2:
        raise ValueError(f"coordinates must have shape (n, 2), got shape {xy.shape}")
    n = xy.shape[0]
    if n > MAX_ROWS:
        raise ValueError(f"{n} cells is more than the {MAX_ROWS} a uint32 source row can number")
    for kind, columns in (("categorical", ds.codes), ("numeric", ds.numeric)):
        for field, col in columns.items():
            if np.shape(col) != (n,):
                raise ValueError(
                    f"{kind} field {field!r} has shape {np.shape(col)}, but there are "
                    f"{n} coordinate rows; every column needs one value per cell"
                )
    ids = _checked_ids(ds.ids, n)
    rows = np.arange(n, dtype=np.uint32)
    codes = dict(ds.codes)
    numeric = {k: np.asarray(v, dtype=np.float32) for k, v in ds.numeric.items()}

    keep = np.isfinite(xy).all(axis=1)
    kept = int(keep.sum())
    if kept == 0:
        raise ValueError(f"none of the {n} cells has finite coordinates; nothing to write")
    if kept < n:
        _warn(f"dropped {n - kept} of {n} cells whose x or y is not finite (NaN or infinite)")
        xy = xy[keep]
        codes = {k: v[keep] for k, v in codes.items()}
        numeric = {k: v[keep] for k, v in numeric.items()}
        ids = None if ids is None else ids[keep]
        rows = rows[keep]

    names = [*codes, *numeric]
    safe = safe_field_names([str(f) for f in names])
    renames = [(old, new) for old, new in zip(names, safe) if str(old) != new]
    if renames:
        _warn("renamed fields that are not safe in URLs and paths: "
              + ", ".join(f"{str(old)!r} -> {new!r}" for old, new in renames))
    code_names, num_names = safe[: len(codes)], safe[len(codes):]
    return SimDataset(
        xy=xy,
        codes=dict(zip(code_names, codes.values())),
        levels={new: ds.levels[old] for old, new in zip(codes, code_names)},
        numeric=dict(zip(num_names, numeric.values())),
        ids=None if ids is None else _utf8(ids),
        source_rows=rows,
    )


def _finite_range(values: np.ndarray) -> dict:
    """Range over the finite values only. NaN marks a missing value and stays
    in the chunk; it must not turn the colour scale into NaN. A column with no
    finite value at all gets [0, 0]."""
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return {"min": 0.0, "max": 0.0}
    return {"min": float(finite.min()), "max": float(finite.max())}


def _atomic_write(path: Path, write: Callable[[Path], object]) -> None:
    """Write to a sibling and rename over the target, so a server reading
    while tiles are regenerated sees the old file or the new one, never half
    of one."""
    tmp = path.with_name(path.name + ".tmp")
    write(tmp)
    os.replace(tmp, path)


def _write_column(
    base: Path,
    arr: np.ndarray,
    chunk_size: int,
    per_row: int,
    hasher=None,
    label: str = "",
) -> None:
    base.mkdir(parents=True, exist_ok=True)
    n = arr.shape[0]
    for c, start in enumerate(range(0, n, chunk_size)):
        stop = min(start + chunk_size, n)
        block = np.ascontiguousarray(arr[start:stop])
        assert block.size == (stop - start) * per_row
        _atomic_write(base / f"{c:03d}.bin", block.tofile)
        if hasher is not None:
            hasher.update(f"{label}/{c:03d}:{block.dtype.str}:{block.nbytes}\n".encode())
            hasher.update(block)


def _save_npy(arr: np.ndarray, path: Path) -> None:
    """np.save given a name appends `.npy` unless the name already ends so,
    which would leave the bytes beside the temporary file `_atomic_write`
    renames. Given an open file it writes exactly where it is told."""
    with open(path, "wb") as f:
        np.save(f, arr, allow_pickle=False)


def _write_cells(base: Path, ds: SimDataset, hasher) -> None:
    """Each cell's source row (`rows.npy`, uint32) and, when the source named
    its cells, its id (`ids.npy`, fixed-width UTF-8), both in shuffled order.

    Whole `.npy` files rather than chunks: the browser never downloads them,
    the server looks one cell up at a time through a memory map. Both feed
    the version hash, so renaming a single cell moves the version as any
    other changed byte does.
    """
    base.mkdir(parents=True, exist_ok=True)
    files = {"rows.npy": ds.source_rows.astype(np.uint32, copy=False)}
    if ds.ids is not None:
        files["ids.npy"] = ds.ids
    for name, arr in files.items():
        arr = np.ascontiguousarray(arr)
        _atomic_write(base / name, partial(_save_npy, arr))
        hasher.update(f"cells/{name}:{arr.dtype.str}:{arr.nbytes}\n".encode())
        hasher.update(arr)


def write_tiles(
    ds: SimDataset,
    out_dir: Path | str,
    dataset_id: str,
    chunk_size: int = 250_000,
    graph: PrincipalGraph | None = None,
    seed: int = 0,
    extra: dict | None = None,
) -> dict:
    """Shuffle `ds` and write it as chunks plus a manifest under
    `out_dir/dataset_id`, with each cell's source row and id under `cells/`.

    `extra`, if given, is recorded in the manifest as `meta`: what a dataset
    says about itself (the organ view marks its simulated datasets
    `synthetic`). It is part of the hashed body, so changing it moves the
    version like any other change.

    The manifest's `version` is the first 16 hex digits of a SHA-256 over
    every chunk and cell file written (its path, dtype, length and bytes),
    then the manifest body, then the graph. It is a pure function of the output:
    rewriting identical tiles keeps the version, so browser caches stay warm,
    while any change to any byte, in any chunk of any column, moves it. That
    is what makes `immutable` caching of `chunk/...?v=<version>` safe.
    Hashing everything is cheap next to the shuffle (about 20 MB per million
    cells for the simulated datasets).
    """
    check_dataset_id(dataset_id)
    _check_codes(ds)
    ds = _servable(ds)
    root = Path(out_dir) / dataset_id
    root.mkdir(parents=True, exist_ok=True)

    sh = shuffle_dataset(ds, seed=seed)
    n = sh.n
    chunks = (n + chunk_size - 1) // chunk_size

    hasher = hashlib.sha256()
    _write_column(root / "xy", sh.xy, chunk_size, per_row=2, hasher=hasher, label="xy")
    for field, codes in sh.codes.items():
        _write_column(
            root / "codes" / field, codes.astype(np.uint16, copy=False), chunk_size, per_row=1,
            hasher=hasher, label=f"codes/{field}",
        )
    for field, values in sh.numeric.items():
        _write_column(
            root / "num" / field, values.astype(np.float32, copy=False), chunk_size, per_row=1,
            hasher=hasher, label=f"num/{field}",
        )
    _write_cells(root / "cells", sh, hasher)

    pad =0.02 * max(float(np.ptp(sh.xy[:, 0])), float(np.ptp(sh.xy[:, 1])), 1e-6)
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
        "numeric": {f: _finite_range(v) for f, v in sh.numeric.items()},
        "hasGraph": graph is not None,
        "cellIds": sh.ids is not None,
    }
    if extra:
        manifest["meta"] = dict(extra)

    graph_json = None
    if graph is not None:
        graph_json = json.dumps({
            "nodes": graph.nodes.astype(float).tolist(),
            "edges": [[int(i), int(j)] for i, j in graph.edges],
            "root": int(graph.root),
            "branchPoints": [int(i) for i in graph.branch_points],
            "leaves": [int(i) for i in graph.leaves],
        }, allow_nan=False)

    # allow_nan=False: the browser's JSON.parse rejects NaN and Infinity, so
    # failing here is better than writing a manifest no client can read.
    hasher.update(json.dumps(manifest, sort_keys=True, allow_nan=False).encode())
    if graph_json is not None:
        hasher.update(graph_json.encode())
    manifest["version"] = hasher.hexdigest()[:VERSION_HEX]

    if graph_json is not None:
        _atomic_write(root / "graph.json", lambda p: p.write_text(graph_json))
    # The manifest goes last: it is what makes the new chunks reachable.
    text = json.dumps(manifest, allow_nan=False)
    _atomic_write(root / "manifest.json", lambda p: p.write_text(text))
    _prune(root, manifest)
    return manifest


def _check_codes(ds: SimDataset) -> None:
    """Every code must index its level list and fit a uint16.

    The writer casts codes to uint16; a negative code, one past the end of the
    level list, or one wider than 16 bits would wrap silently and colour cells
    as the wrong population, so it is an error instead.
    """
    for field, codes in ds.codes.items():
        levels = len(ds.levels.get(field, []))
        if levels > MAX_LEVELS:
            raise ValueError(f"field '{field}' has {levels} levels, more than {MAX_LEVELS}")
        if codes.size == 0:
            continue
        lo, hi = int(np.min(codes)), int(np.max(codes))
        if lo < 0 or hi >= levels:
            raise ValueError(
                f"field '{field}' has codes {lo}..{hi} but only {levels} levels"
            )


def _prune(root: Path, manifest: dict) -> None:
    """Removes files the manifest no longer references.

    Regenerating a dataset with fewer fields or fewer chunks would otherwise
    leave the old ones on disk: harmless to the browser, which only follows the
    manifest, but confusing to anyone reading the directory, and wasted space.
    Runs after the manifest is written, so nothing it deletes is reachable.
    """
    keep = {f"{c:03d}.bin" for c in range(manifest["chunks"])}

    def prune_chunks(d: Path) -> None:
        for f in d.glob("*.bin"):
            if f.name not in keep:
                f.unlink()

    prune_chunks(root / "xy")
    for kind, fields in (("codes", manifest["categorical"]), ("num", manifest["numeric"])):
        base = root / kind
        if not base.is_dir():
            continue
        for d in base.iterdir():
            if not d.is_dir():
                continue
            if d.name in fields:
                prune_chunks(d)
            else:
                shutil.rmtree(d)
    if not manifest["hasGraph"]:
        (root / "graph.json").unlink(missing_ok=True)
    if not manifest["cellIds"]:
        (root / "cells" / "ids.npy").unlink(missing_ok=True)


def _encode_categorical(values, field: str) -> tuple[np.ndarray, list[str]]:
    """String column to uint16 codes plus a level dictionary.

    A column with more distinct values than uint16 can hold is rejected
    rather than truncated: a silently wrapped barcode column would colour
    the plot with plausible-looking nonsense.
    """
    labels = [str(v) for v in values]
    levels = sorted(set(labels))
    if len(levels) > MAX_LEVELS:
        raise TooManyLevelsError(field, len(levels))
    index = {label: i for i, label in enumerate(levels)}
    codes = np.fromiter((index[v] for v in labels), dtype=np.uint16, count=len(labels))
    return codes, levels


def _encode_fields(
    fields: list[str], column: Callable[[str], np.ndarray], explicit: bool
) -> tuple[dict[str, np.ndarray], dict[str, list[str]]]:
    """Encode categorical fields.

    A field the user named explicitly that cannot be encoded is an error. An
    auto-detected one — a per-cell column such as a clonotype, or a barcode
    column in an h5ad, whose cells are named by obs_names instead — is skipped
    with a warning, because a whole file should not fail to load over a
    column nobody asked to colour by.
    """
    codes: dict[str, np.ndarray] = {}
    levels: dict[str, list[str]] = {}
    for field_name in fields:
        try:
            codes[field_name], levels[field_name] = _encode_categorical(
                column(field_name), field_name
            )
        except TooManyLevelsError as err:
            if explicit:
                raise
            _warn(f"skipped auto-detected field {field_name!r}: {err.levels} distinct values "
                  f"is more than the {MAX_LEVELS} a uint16 code can represent")
    return codes, levels


def _require_columns(requested: list[str], available, what: str) -> None:
    missing = [f for f in requested if f not in available]
    if missing:
        raise KeyError(f"{what} {missing} not found; available: {list(available)}")


def dataset_from_h5ad(
    path,
    embedding_key: str = "X_umap",
    obs_fields: list[str] | None = None,
    numeric_fields: list[str] | None = None,
) -> SimDataset:
    """Read an AnnData file. A field list left as None is auto-detected:
    non-numeric obs columns are categorical, numeric ones are numeric. Cells
    are named by obs_names, the index rather than a column, so the names can
    never be ingested as a field by mistake."""
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

    explicit_obs = obs_fields is not None
    if obs_fields is None:
        obs_fields = [c for c in obs.columns if not is_numeric_dtype(obs[c])]
    else:
        _require_columns(obs_fields, obs.columns, "obs field(s)")
    if numeric_fields is None:
        numeric_fields = [
            c for c in obs.columns if is_numeric_dtype(obs[c]) and c not in obs_fields
        ]
    else:
        _require_columns(numeric_fields, obs.columns, "numeric field(s)")

    codes, levels = _encode_fields(obs_fields, lambda f: obs[f].to_numpy(), explicit_obs)
    numeric = {
        f: np.ascontiguousarray(obs[f].to_numpy(), dtype=np.float32) for f in numeric_fields
    }
    ids = np.asarray(adata.obs_names, dtype=np.str_)
    return SimDataset(xy=xy, codes=codes, levels=levels, numeric=numeric, ids=ids)


def _pick_id_column(
    cols: list[str], id_column: str | None, claimed: set[str]
) -> str | None:
    """The column that names each cell, or None.

    A column the user named is required to exist, and may not also be one of
    the fields they asked for: one column cannot be both a cell's name and
    something to colour by. Without one, the first of `ID_COLUMNS` present
    is used, unless the user claimed it as a field or coordinate. Picking it
    is only a convention, so an explicit request outranks it.
    """
    if id_column is not None:
        _require_columns([id_column], cols, "id column")
        if id_column in claimed:
            raise ValueError(
                f"column {id_column!r} is the cell id column, so it cannot also be "
                f"a coordinate or a categorical or numeric field"
            )
        return id_column
    return next((c for c in ID_COLUMNS if c in cols and c not in claimed), None)


def _id_strings(column) -> np.ndarray:
    """An Arrow column as one string per cell. Numbers become their decimal
    text, and a missing id becomes the empty string rather than "None"."""
    import pyarrow as pa
    import pyarrow.compute as pc

    text = pc.fill_null(column.cast(pa.large_string()), "")
    return np.asarray(text.to_numpy(zero_copy_only=False), dtype=np.str_)


def dataset_from_parquet(
    path,
    x: str = "x",
    y: str = "y",
    obs_fields: list[str] | None = None,
    numeric_fields: list[str] | None = None,
    id_column: str | None = None,
) -> SimDataset:
    """Read a Parquet table with one row per cell. Each field list left as
    None is auto-detected independently, exactly as for h5ad: naming only
    the numeric fields still picks up every categorical column.

    Cells are named by `id_column`, or else by the first of `cell_id`,
    `barcode` and `obs_names` present. That column is never also ingested as
    a field: a barcode is unique per cell, so as a categorical it would only
    have been skipped for having too many levels."""
    import pyarrow.parquet as pq

    table = pq.read_table(path)
    cols = table.column_names
    for needed in (x, y):
        if needed not in cols:
            raise KeyError(f"column '{needed}' not in parquet file; available: {cols}")
    claimed = {x, y, *(obs_fields or []), *(numeric_fields or [])}
    id_col = _pick_id_column(cols, id_column, claimed)

    xs = np.asarray(table[x].to_numpy(zero_copy_only=False), dtype=np.float32)
    ys = np.asarray(table[y].to_numpy(zero_copy_only=False), dtype=np.float32)
    xy = np.ascontiguousarray(np.stack([xs, ys], axis=1))

    arrays: dict[str, np.ndarray] = {}

    def column(c: str) -> np.ndarray:
        if c not in arrays:
            arrays[c] = table[c].to_numpy(zero_copy_only=False)
        return arrays[c]

    def is_number(c: str) -> bool:
        return np.issubdtype(column(c).dtype, np.number)

    rest = [c for c in cols if c not in (x, y, id_col)]
    explicit_obs = obs_fields is not None
    if obs_fields is None:
        obs_fields = [c for c in rest if not is_number(c)]
    else:
        _require_columns(obs_fields, cols, "obs field(s)")
    if numeric_fields is None:
        numeric_fields = [c for c in rest if is_number(c) and c not in obs_fields]
    else:
        _require_columns(numeric_fields, cols, "numeric field(s)")

    codes, levels = _encode_fields(obs_fields, column, explicit_obs)
    numeric = {f: np.ascontiguousarray(column(f), dtype=np.float32) for f in numeric_fields}
    ids = None if id_col is None else _id_strings(table[id_col])
    return SimDataset(xy=xy, codes=codes, levels=levels, numeric=numeric, ids=ids)


def graph_from_json(path) -> PrincipalGraph:
    """Read a principal graph file in the format `write_tiles` writes to
    `graph.json` (`nodes`, `edges`, `root`, `branchPoints`, `leaves`).

    Every index is checked against the node count, because the viewer indexes
    straight into `nodes` and a stray index would draw a line to nowhere.
    Raises ValueError saying what is wrong.
    """
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise ValueError(f"cannot read graph file {path}: {err}") from err
    if not isinstance(raw, dict):
        raise ValueError("a graph file must be a JSON object")
    missing = [k for k in ("nodes", "edges", "root") if k not in raw]
    if missing:
        raise ValueError(f"graph file is missing: {', '.join(missing)}")
    try:
        nodes = np.asarray(raw["nodes"], dtype=np.float64)
    except (TypeError, ValueError) as err:
        raise ValueError("graph 'nodes' must be a list of [x, y] numbers") from err
    if nodes.ndim != 2 or nodes.shape[1] != 2 or nodes.shape[0] == 0 or not np.isfinite(nodes).all():
        raise ValueError("graph 'nodes' must be a non-empty list of finite [x, y] pairs")
    count = nodes.shape[0]

    def index(value, what: str) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value < count:
            raise ValueError(f"graph {what} {value!r} is not a node index in 0..{count - 1}")
        return value

    edges: list[tuple[int, int]] = []
    for e in raw["edges"]:
        if not isinstance(e, (list, tuple)) or len(e) != 2:
            raise ValueError(f"graph edge {e!r} must be a pair of node indices")
        edges.append((index(e[0], "edge end"), index(e[1], "edge end")))
    return PrincipalGraph(
        nodes=nodes,
        edges=edges,
        root=index(raw["root"], "root"),
        branch_points=[index(i, "branch point") for i in raw.get("branchPoints", [])],
        leaves=[index(i, "leaf") for i in raw.get("leaves", [])],
    )


def dataset_label(n: int) -> str:
    """The exact size part of a generated dataset id: `1m`, `1500k`, `500`.

    It never rounds. `m` means a whole number of millions and `k` a whole
    number of thousands, so two different sizes can never share an id; the
    old truncating label sent 1,000,000 and 1,500,000 both to `sim1m`.
    """
    if n > 0 and n % 1_000_000 == 0:
        return f"{n // 1_000_000}m"
    if n > 0 and n % 1000 == 0:
        return f"{n // 1000}k"
    return str(n)


def _field_list(values: list[str] | None) -> list[str] | None:
    """`--obs-fields a,b c` gives ['a', 'b', 'c']. Commas split one argument;
    separate arguments are separate fields. A name containing a space is
    passed as one quoted argument (`"cell type"`), so spaces inside an
    argument do not split it."""
    if values is None:
        return None
    return [f.strip() for v in values for f in v.split(",") if f.strip()]


def _main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Build tile datasets.")
    ap.add_argument("--out", default="data/tiles")
    ap.add_argument("--chunk-size", type=int, default=250_000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--sizes", type=int, nargs="*", default=[100_000, 1_000_000],
                    help="embedding dataset sizes to generate (none, to skip them)")
    ap.add_argument("--organ-size", type=int, default=0,
                    help="cells per organ for the Organ View's synthetic heart, brain and liver "
                         "(a UMAP and a trajectory each), 0 to skip")
    ap.add_argument("--traj-size", type=int, default=500_000)
    ap.add_argument("--atlas-size", type=int, default=0,
                    help="multi-organ atlas size (tissue + anatomical_region), 0 to skip")
    ap.add_argument("--h5ad", help="ingest an .h5ad file instead of simulating")
    ap.add_argument("--parquet", help="ingest a Parquet file instead of simulating")
    ap.add_argument("--id", help="dataset id for an ingested file")
    ap.add_argument("--embedding", default="X_umap")
    ap.add_argument("--obs-fields", nargs="+", metavar="FIELD",
                    help="categorical columns to ingest, comma or space separated "
                         "(default: every non-numeric column, skipping any with more "
                         f"than {MAX_LEVELS} distinct values)")
    ap.add_argument("--numeric-fields", nargs="+", metavar="FIELD",
                    help="numeric columns to ingest, comma or space separated "
                         "(default: every numeric column not in --obs-fields)")
    ap.add_argument("--graph", metavar="FILE",
                    help="principal graph JSON to attach to an ingested trajectory dataset "
                         "(nodes, edges, root, branchPoints, leaves)")
    ap.add_argument("--id-column", metavar="COLUMN",
                    help="Parquet column naming each cell, never ingested as a field "
                         f"(default: the first of {', '.join(ID_COLUMNS)} present; "
                         "an h5ad always uses obs_names)")
    args = ap.parse_args()
    obs_fields = _field_list(args.obs_fields)
    numeric_fields = _field_list(args.numeric_fields)
    if args.graph and not (args.h5ad or args.parquet):
        ap.error("--graph applies only when ingesting with --h5ad or --parquet")
    if args.id_column is not None and not args.parquet:
        ap.error("--id-column applies only when ingesting with --parquet; "
                 "an h5ad names its cells by obs_names")

    if args.h5ad or args.parquet:
        if not args.id:
            ap.error("--id is required when ingesting a file")
        try:
            check_dataset_id(args.id)
        except ValueError as err:
            ap.error(str(err))
        try:
            ds = (dataset_from_h5ad(args.h5ad, embedding_key=args.embedding,
                                    obs_fields=obs_fields, numeric_fields=numeric_fields)
                  if args.h5ad else
                  dataset_from_parquet(args.parquet, obs_fields=obs_fields,
                                       numeric_fields=numeric_fields,
                                       id_column=args.id_column))
            graph = graph_from_json(args.graph) if args.graph else None
            man = write_tiles(ds, args.out, args.id, args.chunk_size, graph=graph, seed=args.seed)
        except (KeyError, ValueError) as err:
            # A data problem, not a bug: say what is wrong without a traceback.
            sys.exit(f"error: {err.args[0] if err.args else err}")
        print(f"wrote {args.id}: {man['n']} cells, {man['chunks']} chunks, "
              f"fields {sorted(man['categorical'])}")
        return

    if obs_fields is not None or numeric_fields is not None:
        ap.error("--obs-fields and --numeric-fields apply only when ingesting "
                 "with --h5ad or --parquet")

    from .simulate import simulate_atlas, simulate_embedding, simulate_trajectory

    # Name every dataset before writing any, so a collision fails cleanly
    # instead of one size silently overwriting another.
    sims = [(f"sim{dataset_label(n)}", n) for n in args.sizes]
    traj_id = f"traj{dataset_label(args.traj_size)}" if args.traj_size else None
    atlas_id = f"atlas{dataset_label(args.atlas_size)}" if args.atlas_size else None
    ids = [i for i, _ in sims] + [i for i in (traj_id, atlas_id) if i]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        ap.error(f"these sizes give the same dataset id, so one would overwrite "
                 f"the other: {', '.join(dupes)}")

    for ds_id, n in sims:
        ds = simulate_embedding(n, seed=args.seed)
        man = write_tiles(ds, args.out, ds_id, args.chunk_size, seed=args.seed)
        print(f"wrote {ds_id}: {man['n']} cells, {man['chunks']} chunks")

    if traj_id:
        ds, g = simulate_trajectory(args.traj_size, seed=args.seed)
        man = write_tiles(ds, args.out, traj_id, args.chunk_size, graph=g, seed=args.seed)
        print(f"wrote {traj_id}: {man['n']} cells, {len(g.edges)} graph edges")

    if atlas_id:
        ds = simulate_atlas(args.atlas_size, seed=args.seed)
        man = write_tiles(ds, args.out, atlas_id, args.chunk_size, seed=args.seed)
        print(f"wrote {atlas_id}: {man['n']} cells, "
              f"{len(man['categorical']['tissue']['levels'])} organs")

    if args.organ_size:
        from .organs import build_organ_tiles

        try:
            made = build_organ_tiles(args.out, args.organ_size, args.chunk_size, seed=args.seed)
        except ValueError as err:
            ap.error(str(err))
        for organ, pair in made.items():
            print(f"wrote {pair['umap']['datasetId']} and {pair['trajectory']['datasetId']}: "
                  f"{pair['umap']['n']} synthetic cells each ({organ})")


if __name__ == "__main__":
    _main()
