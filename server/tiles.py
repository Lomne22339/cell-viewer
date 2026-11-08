"""Binary tile routes, plus a per-cell lookup of source row and id.

Dataset ids and field names arrive from the URL and are used to build
filesystem paths, so both are validated against a strict pattern before
they touch the disk. Concatenating unvalidated path segments is how a
tile server becomes a file-read primitive.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .names import SAFE_NAME

__all__ = ["SAFE_NAME", "router"]

#: path -> (manifest version, mapped array or None when the file is absent).
_mapped: dict[str, tuple[str, np.ndarray | None]] = {}


def _safe(name: str) -> str:
    # fullmatch, not match: with match a trailing newline slipped through.
    if not SAFE_NAME.fullmatch(name):
        raise HTTPException(status_code=400, detail="invalid name")
    return name


def _dataset_root(request: Request, dataset_id: str) -> Path:
    root = Path(request.app.state.tiles_dir) / _safe(dataset_id)
    if not (root / "manifest.json").is_file():
        raise HTTPException(status_code=404, detail="unknown dataset")
    return root


def _send_binary(path: Path) -> Response:
    # Immutable caching is safe because the browser asks for chunks as
    # `...?v=<manifest version>`, and the version changes whenever the bytes
    # do. The route itself ignores the query string: the URL is the cache key,
    # the path alone picks the file.
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no such chunk")
    return Response(
        content=path.read_bytes(),
        media_type="application/octet-stream",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


def _open_column(path: str, version: str) -> np.ndarray | None:
    """A cell file memory-mapped, or None when it does not exist.

    Mapped rather than read, so looking up one cell touches a page or two
    instead of the whole file (some 20 MB of ids for a million cells). The
    mapping is reused only while the manifest version is the one it was
    opened under: regenerating a dataset writes new files and a new version,
    so the next lookup maps the new file, and the old mapping is dropped
    rather than kept alive holding a replaced file's disk space.
    """
    hit = _mapped.get(path)
    if hit is not None and hit[0] == version:
        return hit[1]
    p = Path(path)
    arr = np.load(p, mmap_mode="r", allow_pickle=False) if p.is_file() else None
    _mapped[path] = (version, arr)
    return arr


def _cell_file(root: Path, name: str, version: str, n: int) -> np.ndarray | None:
    arr = _open_column(str(root / "cells" / name), version)
    # A file of another length was written for other cells (one caught
    # mid-regeneration, say), so it cannot describe these.
    return arr if arr is not None and arr.shape == (n,) else None


router = APIRouter(prefix="/api")


@router.get("/datasets")
def list_datasets(request: Request) -> JSONResponse:
    root = Path(request.app.state.tiles_dir)
    ids = (
        sorted(p.name for p in root.iterdir() if (p / "manifest.json").is_file())
        if root.is_dir()
        else []
    )
    return JSONResponse({"datasets": ids})


@router.get("/dataset/{dataset_id}/manifest")
def manifest(request: Request, dataset_id: str) -> JSONResponse:
    root = _dataset_root(request, dataset_id)
    return JSONResponse(json.loads((root / "manifest.json").read_text()))


@router.get("/dataset/{dataset_id}/graph")
def graph(request: Request, dataset_id: str) -> JSONResponse:
    root = _dataset_root(request, dataset_id)
    path = root / "graph.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="dataset has no principal graph")
    return JSONResponse(json.loads(path.read_text()))


@router.get("/dataset/{dataset_id}/cell/{index}")
def cell(request: Request, dataset_id: str, index: int, v: str | None = None) -> JSONResponse:
    """A shuffled cell index back to the cell's own name and its row in the
    source file, which is how a clicked cell is found again in the user's
    AnnData or Parquet. Tiles written before cell files existed answer nulls
    rather than an error, so the card can still show the index.

    `v` is the manifest version the page loaded. An index only means
    something within one version, so a page that is still showing the chunks
    of a dataset that has since been regenerated gets 409, not the name of
    whichever cell now sits at that position."""
    root = _dataset_root(request, dataset_id)
    man = json.loads((root / "manifest.json").read_text())
    n = int(man["n"])
    version = str(man.get("version", ""))
    if v is not None and v != version:
        raise HTTPException(status_code=409, detail="dataset changed since the page loaded; reload")
    if not 0 <= index < n:
        raise HTTPException(status_code=404, detail="no such cell")
    rows = _cell_file(root, "rows.npy", version, n)
    if rows is None:
        return JSONResponse({"index": index, "row": None, "id": None})
    ids = _cell_file(root, "ids.npy", version, n) if man.get("cellIds") else None
    name = None if ids is None else bytes(ids[index]).decode("utf-8", errors="replace")
    return JSONResponse({"index": index, "row": int(rows[index]), "id": name})


@router.get("/dataset/{dataset_id}/chunk/xy/{chunk}")
def chunk_xy(request: Request, dataset_id: str, chunk: int) -> Response:
    return _send_binary(_dataset_root(request, dataset_id) / "xy" / f"{chunk:03d}.bin")


@router.get("/dataset/{dataset_id}/chunk/codes/{field}/{chunk}")
def chunk_codes(request: Request, dataset_id: str, field: str, chunk: int) -> Response:
    root = _dataset_root(request, dataset_id)
    return _send_binary(root / "codes" / _safe(field) / f"{chunk:03d}.bin")


@router.get("/dataset/{dataset_id}/chunk/num/{field}/{chunk}")
def chunk_num(request: Request, dataset_id: str, field: str, chunk: int) -> Response:
    root = _dataset_root(request, dataset_id)
    return _send_binary(root / "num" / _safe(field) / f"{chunk:03d}.bin")
