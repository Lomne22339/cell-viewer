from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .chat import router as chat_router
from .tiles import router as tiles_router


DEFAULT_DIST = Path(__file__).resolve().parents[1] / "dist"


def create_app(
    tiles_dir: Path | str = "data/tiles",
    dist_dir: Path | str | None = None,
) -> FastAPI:
    app = FastAPI(title="Cell Viewer")
    app.state.tiles_dir = Path(tiles_dir)
    # CORS is only a fallback for a page pointed straight at this server (VITE_API). Any localhost
    # port is allowed because Vite moves to 5174 when 5173 is busy; CORS_ORIGINS adds extra origins.
    extra = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=extra,
        allow_origin_regex=r"https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?",
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )
    app.include_router(tiles_router)
    app.include_router(chat_router)

    dist = Path(dist_dir) if dist_dir is not None else DEFAULT_DIST
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="app")
    return app


app = create_app(os.environ.get("TILES_DIR", "data/tiles"))
