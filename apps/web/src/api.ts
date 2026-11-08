/**
 * Where the data server is, as seen from the page.
 *
 * Empty — the same origin — by default. In development Vite proxies `/api` to
 * the FastAPI server (see vite.config.ts), and in production FastAPI serves the
 * built page itself, so either way the browser only ever talks to the origin
 * it loaded the page from. That makes the dev-server port irrelevant: when 5173
 * is taken and Vite moves to 5174, nothing breaks, and no cross-origin request
 * (with its CORS allow-list) is involved at all.
 *
 * `VITE_API` overrides it for a deliberately separate API host.
 */
export const API = ((import.meta.env.VITE_API as string | undefined) ?? '').replace(/\/+$/, '');

/** How to start the data server, for error messages. */
export const START_SERVER_HINT = '.venv/bin/python -m uvicorn server.main:app --port 8000';
