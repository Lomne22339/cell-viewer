/** Base URL of the data server: empty (same origin) unless `VITE_API` points at another host. */
export const API = ((import.meta.env.VITE_API as string | undefined) ?? '').replace(/\/+$/, '');

export const START_SERVER_HINT = '.venv/bin/python -m uvicorn server.main:app --port 8000';
