---
name: cell-viewer-invariants
description: The performance, architecture and security rules of the Cell Viewer, with the reasoning behind each and the patterns to use instead. Load before designing or reviewing any change to rendering, selection, colouring, filtering or data loading.
---

# Cell Viewer invariants and the patterns that honour them

| Rule | Why | Do this instead |
|---|---|---|
| Typed arrays only for per-cell data | An object per cell costs more in GC than the whole render loop at 1M cells | `Uint8Array` masks, `Uint32Array` index lists, flat loops |
| Core is DOM-free | Lets 100+ tests run in Node in under a second | Put pure logic in `packages/core/src/<area>`, wire it in `apps/web` |
| Opaque points, no blending (the opt-in "Translucent points" toggle, off by default, is the one exception) | Blending cost 3–4× the frame rate on tile GPUs (see the benchmark doc) | Dim = lerp RGB toward the theme background; hide = alpha 0 plus vertex-shader cull |
| Layers not pickable | A hover picking pass costs about 15% of the frame and caused the UI-1 "jumping" | `SelectionClient.nearest()` on click |
| Chunk layers cached by key | A rebuild on pointermove wedged lasso drags at 10M | Bump `colorVersion` only when the colour buffer changed |
| `loadedCount` is a prefix | Chunks land out of order, and unwritten slots are zero | Loop `i < store.loadedCount`; clamp worker counts |
| Exact spatial queries | An index that drops points is worse than none | Grid narrows candidates, then a full test per candidate; property-test against brute force |
| Selection state only in `SelectionStore` | Many consumers (canvas, summary, chat, anatomy) | `ScatterView` keeps the raw selection and stores `raw ∩ visible` |
| Summaries, not rows, to the model | Token cost must not scale with the lasso size | `buildSelectionContext` |
| `esc()` for dataset strings | `.h5ad` files come from anywhere | `esc(label)` in templates; `textContent` for free text |

## Cost classes allowed for UI actions

- Per frame: O(chunks) at most. Never O(n).
- Per user action (colour-by, filter toggle, selection, theme): one O(n) pass is
  fine. At 10M cells a flat loop takes about 30–80 ms. Coalesce repeated
  triggers.
- Per data chunk: O(chunk) only. Never re-touch earlier chunks.

## Recolour pipeline (single source of truth)

`ScatterCanvas.repaint()` calls `recolorCategorical` or `recolorNumeric` with
`{mask, factor, background, visible}`, then bumps `colorVersion`. Every visual
state that affects point colour (colour-by, selection mask, filter visibility,
theme background, blend mode) feeds this one call. Do not write
`store.color` anywhere else.
