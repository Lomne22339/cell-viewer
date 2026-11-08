# Cell Viewer — project guide for Claude Code

GPU scatter plot for single-cell embeddings (UMAP/t-SNE) and trajectories, built
to hold 1–10 million cells. TypeScript + Vite + deck.gl in the browser, FastAPI +
NumPy on the server. Read `README.md` for the user-facing tour and
`docs/superpowers/specs/` for the designs.

## Commands

```bash
npx tsc --noEmit                         # types (must be 0 errors)
npx vitest run                           # core unit tests, Node only
.venv/bin/python -m pytest -q            # server tests
npx playwright test                      # e2e, real WebGL via SwiftShader (starts both servers)
node scripts/visual-check.mjs            # screenshots of every theme/feature -> test-results/visual/
.venv/bin/python -m server.prep --sizes 100000 1000000 --traj-size 500000 --atlas-size 300000
.venv/bin/python -m uvicorn server.main:app --port 8000   # API
npm run dev                                              # UI on :5173
```

`.venv` is Python 3.13 (created with `uv venv --python 3.13 .venv`). Generated
tiles live in `data/tiles/` and are git-ignored.

The page calls `/api/...` on its own origin and Vite proxies that to the API
(`API_TARGET`, default `http://localhost:8000`), so the UI works on whatever
port Vite picks. `VITE_API` points the page at a separate API host instead;
the server's CORS rule accepts any localhost port plus `CORS_ORIGINS`.

## Layout

```
packages/core/src   pure logic: data, index, select, color, graph, filter, inset, anatomy, theme
packages/core/test  Vitest, one file per area
apps/web/src        deck.gl canvas, views, UI panels, interactions, chat, anatomy view, inset
server/             simulate.py (synthetic data), prep.py (tiling/ingest), tiles.py, chat.py
e2e/                Playwright specs (viewer.spec.ts correctness, feedback.spec.ts new features)
docs/               spec, plans, benchmarks, verification reports, ADDING_AN_ORGAN.md
.claude/            project agents, skills and hooks (see below)
```

## Invariants (hard rules; hooks and reviewers enforce them)

1. **No per-cell objects.** Every per-cell column is a typed array. Hot loops are
   flat `for` loops with no allocation per element.
2. **`packages/core` is DOM-free and deck.gl-free.** It must import in Node. Pure
   logic goes there *with a test*. `apps/web` only wires and draws.
3. **Points are opaque, blending off.** Selection dimming blends RGB toward the
   theme background. Hidden (filtered-out) cells get alpha 0 and are culled in
   the vertex shader. The only blended path is the pre-existing, opt-in
   "Translucent points" toggle (off by default, measured as the costliest
   setting). Never add another one, and never turn it on by default.
4. **Point layers are not pickable.** Clicking a cell asks the selection
   worker's grid index (`nearest` query). Hover does nothing on the plot. This
   is a standing UI requirement.
5. **`[0, store.loadedCount)` is the only real data.** Anything past it is
   unwritten.
6. **Spatial queries equal brute force exactly**, proven by property tests.
7. **Selection state lives only in `SelectionStore`.** The raw selection is
   intersected with the category filter before it reaches the store.
8. **The API key never reaches the browser.** It stays in the `server/chat.py`
   environment.
9. **Dataset strings go through `esc()`** before reaching innerHTML.
10. **Colours that depend on the background come from the active `Theme`.**
    That means CSS custom properties in the DOM and `Theme` RGB in deck layers.
    The four themes are black, white, grey and light yellow.

## Conventions

- Doc comments explain *why*, in full sentences, like the existing code. Use
  British spelling in prose ("colour").
- One concern per module, and small files. New UI panels follow the
  `createX(root, ...) -> handle` pattern in `apps/web/src/ui`.
- Write the test first: Vitest for core, pytest for server, Playwright for
  behaviour.
- Organs are data. A new organ is one model file plus one registry line (see
  `docs/ADDING_AN_ORGAN.md` and the `add-organ-model` skill).

## Claude Code harness in this repo

- **Hooks** (`.claude/settings.json`):
  - `post-edit-guard.sh` blocks DOM or deck.gl code in core and credentials in
    web code. It also runs the related Vitest tests after each core edit and
    `py_compile` after each server edit.
  - `stop-gate.sh` runs tsc, vitest and pytest before a turn may end, but only
    when sources changed since the last green run.
- **Agents** (`.claude/agents/`): core-tdd-engineer, web-ui-engineer,
  anatomy-illustrator, server-data-engineer, invariant-reviewer, visual-qa.
- **Skills** (`.claude/skills/`): `quality-gate`, `visual-check`,
  `add-organ-model`, `cell-viewer-invariants`.
- **MCP** (`.mcp.json`): Playwright browser automation for interactive UI
  inspection.

## Active work

Lab handover: the Organ View, the Differentiation Protocol Creator and the lab
chatbot integration. See `README.md`, `docs/ORGAN_DATA.md` and
`docs/CHATBOT_INTEGRATION.md`.
