from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .chat import router as chat_router
from .chatbot_proxy import router as chatbot_router
from .tiles import router as tiles_router


DEFAULT_DIST = Path(__file__).resolve().parents[1] / "dist"


def create_app(
    tiles_dir: Path | str = "data/tiles",
    dist_dir: Path | str | None = None,
) -> FastAPI:
    app = FastAPI(title="Cell Viewer")
    app.state.tiles_dir = Path(tiles_dir)
    # The dev page normally reaches the API through Vite's same-origin proxy,
    # so CORS is only a fallback for a page pointed at this server directly
    # (VITE_API). Any port on this machine is allowed: Vite moves to 5174 when
    # 5173 is busy, and a fixed list made that page fail with "Failed to fetch".
    # Other sites stay refused. CORS_ORIGINS adds explicit extra origins.
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
    app.include_router(chatbot_router)

    # Serve the production bundle when one has been built, so `npm run build`
    # plus this server is a complete deployment and the API and the page share
    # an origin. Mounted last so it never shadows /api. In development the Vite
    # server handles this instead and the directory simply does not exist.
    dist = Path(dist_dir) if dist_dir is not None else DEFAULT_DIST
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="app")
    return app


app = create_app(os.environ.get("TILES_DIR", "data/tiles"))
