---
name: visual-check
description: Capture and inspect screenshots of the running Cell Viewer across the four background themes and every feedback feature (click card, legend filter, trajectory neighbours, zoom inset, anatomy). Use after any UI change, or when asked to show what the UI looks like.
---

# Visual check

```bash
node scripts/visual-check.mjs                  # everything
node scripts/visual-check.mjs --only themes    # one group: themes | card | legend | trajectory | inset | anatomy
```

The script reuses servers already on :8000 and :5173, or starts them itself.
It writes `test-results/visual/<group>-<name>.png` and prints each path.

Then **open every PNG with the Read tool** and check:
1. Text and swatches are legible on black, white, grey and light yellow.
2. Nothing overlaps or is clipped. The side panel does not shift between
   states.
3. Each feature's evidence is visible (see the visual-qa agent's checklist).

Record defects as `file — problem — fix`. Fix them, rerun the group, and look
again. Before/after pairs of the same name make regressions obvious.
