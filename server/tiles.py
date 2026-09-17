"""Binary tile routes.

Dataset ids and field names arrive from the URL and are used to build
filesystem paths, so both are validated against a strict pattern before
they touch the disk. Concatenating unvalidated path segments is how a
tile server becomes a file-read primitive.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

SAFE_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _safe(name: str) -> str:
    if not SAFE_NAME.match(name):
        raise HTTPException(status_code=400, detail="invalid name")
    return name


def _dataset_root(request: Request, dataset_id: str) -> Path:
    root = Path(request.app.state.tiles_dir) / _safe(dataset_id)
    if not (root / "manifest.json").is_file():
        raise HTTPException(status_code=404, detail="unknown dataset")
    return root


def _send_binary(path: Path) -> Response:
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no such chunk")
    return Response(
        content=path.read_bytes(),
        media_type="application/octet-stream",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


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
