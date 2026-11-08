# Windows Verification

Cell Viewer was successfully set up, run, and verified end-to-end on a native
Windows machine (backend on port 8000, frontend on port 5173). Full details:
[2026-09-08-windows-verification-report.md](2026-09-08-windows-verification-report.md).

## Summary

| Suite | Result |
|---|---|
| Vitest (core) | 107 / 107 passed |
| Pytest (server) | 90 / 90 passed |
| TypeScript (`tsc --noEmit`) | 0 errors |
| Playwright (e2e) | 13 / 14 passed — 1 isolated test-timing issue, not an app defect |

Manual functional verification (UMAP/trajectory rendering, navigation, box/lasso
selection, colour-by, chat integration, datasets up to 10M cells) also passed;
see the full report for scope and disclosed limitations.

**Current status**: both servers run and respond (HTTP 200) as of this
verification. Chat was tested against the offline MockAdapter only — no live
Anthropic API key was configured.
