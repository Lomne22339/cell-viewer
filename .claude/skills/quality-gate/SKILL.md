---
name: quality-gate
description: Run the Cell Viewer's full verification gate (types, unit, server, end-to-end, visual) and report results honestly. Use before declaring any change done, after a merge of several features, or when asked "is it green".
---

# Cell Viewer quality gate

Run these in order and stop at the first red one: fix it, then rerun from that
step.

```bash
npx tsc --noEmit                      # 1. types: expect no output
npx vitest run                        # 2. core: all files pass
.venv/bin/python -m pytest -q         # 3. server: all pass (artefact tests need data/tiles)
npx playwright test                   # 4. e2e: starts uvicorn :8000 and vite :5173 itself
node scripts/visual-check.mjs         # 5. screenshots -> test-results/visual/*.png
```

Notes:
- Run step 4 as `npx playwright test > e2e.log 2>&1; echo exit=$?`. Never pipe it
  into `tail`: the pipe's exit status is 0, which once hid 19 failures.
- Do not run e2e while anything edits modules the app imports. Vite HMR
  reloads the page mid-test.
- Step 4 needs tiles: `.venv/bin/python -m server.prep --sizes 100000 1000000 --traj-size 500000 --atlas-size 300000`.
- Run a single e2e test with `npx playwright test e2e/feedback.spec.ts -g "legend"`.
- Headless WebGL is SwiftShader, so interaction tests use the 100k dataset.
  Do not measure frame rates here. Use `npx playwright test --config=bench.config.ts`
  (headed, real GPU) for that.
- After step 5, open the PNGs with the Read tool. A screenshot nobody looked
  at proves nothing.

Report the exact pass/fail counts for each step. If something was skipped, say
which step and why.
