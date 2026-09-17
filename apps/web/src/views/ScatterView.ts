import type { CellStore } from '@core/data/schema';
import { SelectionStore } from '@core/select/store';
import { SelectionClient } from '@core/select/client';
import type { QueryShape } from '@core/select/worker';
import { buildSelectionContext, type SelectionContext } from '@core/context/build';
import { defaultColorField } from '@core/color/defaults';
import { ScatterCanvas, type ColorKind } from './ScatterCanvas';
import { LassoController } from '../interact/lasso';
import { createToolbar, type ToolbarHandle } from '../ui/Toolbar';
import { createLegend, type LegendHandle } from '../ui/Legend';
import { createLodControl, type LodHandle } from '../ui/LodControl';
import { createSelectionSummary, type SummaryHandle } from '../ui/SelectionSummary';
import { createCellTooltip, type TooltipHandle } from '../ui/CellTooltip';
import { createRenderControl } from '../ui/RenderControl';
import { esc } from '../ui/escape';

export interface ScatterViewOptions {
  view?: 'embedding' | 'trajectory';
  onContext?: (ctx: SelectionContext | null) => void;
  chat?: { setContext: (ctx: SelectionContext | null) => void };
}

/**
 * Composes the canvas, the selection worker, the toolbar and the panels.
 *
 * Nothing here owns selection state: the canvas, the summary and the chat
 * panel all subscribe to one `SelectionStore`, so adding another consumer
 * later means subscribing, not threading a callback through this class.
 */
export class ScatterView {
  readonly canvas: ScatterCanvas;
  readonly selectionStore: SelectionStore;
  protected side: HTMLElement;
  private client = new SelectionClient();
  private lasso: LassoController;
  private toolbar: ToolbarHandle;
  private legend: LegendHandle;
  private lod: LodHandle;
  private summary: SummaryHandle;
  private tooltip: TooltipHandle;
  private colorField: string;
  private colorKind: ColorKind = 'categorical';
  private lastLegendUpdate = 0;

  constructor(
    root: HTMLElement,
    protected store: CellStore,
    protected opts: ScatterViewOptions = {}
  ) {
    root.innerHTML = `<div class="canvas-holder"></div><aside class="side"></aside>`;
    const holder = root.querySelector<HTMLElement>('.canvas-holder')!;
    this.side = root.querySelector<HTMLElement>('.side')!;

    const initial = defaultColorField(store);
    this.colorField = initial?.field ?? '';
    this.colorKind = initial?.kind ?? 'categorical';
    this.selectionStore = new SelectionStore(store.n, store.xy);

    // Everything the canvas's callbacks touch is built before the canvas is.
    // deck.gl may emit onViewStateChange or onHover as soon as it initialises,
    // and a handler reaching for a field that is still undefined would throw
    // from inside the constructor.
    this.tooltip = createCellTooltip(holder, store);
    this.toolbar = createToolbar(this.side, {
      onMode: m => this.lasso.setMode(m),
      onZoomToSelection: () => this.zoomToSelection(),
      onClear: () => this.selectionStore.clear(),
      onResetView: () => this.canvas.fitBounds(store.bounds)
    });
    this.buildColorPicker(this.side);
    this.legend = createLegend(this.side);
    this.lod = createLodControl(this.side, f => {
      this.canvas.setLod(f);
      this.lod.setDrawn(this.canvas.drawnCount(), store.loadedCount);
    });

    this.canvas = new ScatterCanvas(holder, store, {
      onViewStateChange: () => this.lod.setDrawn(this.canvas.drawnCount(), store.loadedCount),
      onHover: (index, x, y) => this.tooltip.show(index, x, y)
    });

    createRenderControl(this.side, this.canvas.blending(), on => this.canvas.setBlending(on));
    this.summary = createSelectionSummary(this.side);

    this.lasso = new LassoController(this.canvas, {
      onComplete: shape => void this.runQuery(shape),
      onCancel: () => this.canvas.setSelectionOverlay([])
    });

    this.selectionStore.subscribe(sel => {
      this.canvas.applyMask(sel ? sel.mask : null);
      this.toolbar.setSelectionActive(sel !== null);
      const ctx = sel
        ? buildSelectionContext(store, sel, {
            datasetId: store.datasetId,
            view: opts.view ?? 'embedding',
            colorBy: this.colorField
          })
        : null;
      this.summary.update(ctx, this.client.lastQueryMs);
      this.opts.chat?.setContext(ctx);
      this.opts.onContext?.(ctx);
    });

    void this.client.ensure(store.xy, store.loadedCount);
    this.updateLegend(true);
    this.syncColorPicker();
    this.lod.setDrawn(this.canvas.drawnCount(), store.loadedCount);
    this.summary.update(null, 0);
  }

  /** Keeps the picker showing whatever the canvas is actually coloured by. */
  private syncColorPicker(): void {
    const select = this.side.querySelector<HTMLSelectElement>('.colorby select');
    if (!select || !this.colorField) return;
    select.value = `${this.colorKind === 'categorical' ? 'c' : 'n'}:${this.colorField}`;
  }

  /**
   * Recounts the legend, at most a few times a second while loading.
   *
   * Counting is one linear pass over every loaded cell. Doing it per chunk
   * costs 200 million increments across a forty-chunk ten-million-cell load,
   * which is comparable to the load itself; the numbers do not need to be
   * that fresh mid-load, and the final state is always exact.
   */
  private updateLegend(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastLegendUpdate < 200) return;
    this.lastLegendUpdate = now;
    this.legend.update(this.store, this.colorField, this.colorKind);
  }

  private buildColorPicker(side: HTMLElement): void {
    const wrap = document.createElement('div');
    wrap.className = 'colorby';
    const cats = this.store.categoricalFields().map(f => `<option value="c:${esc(f)}">${esc(f)}</option>`);
    const nums = this.store.numericFields().map(f => `<option value="n:${esc(f)}">${esc(f)}</option>`);
    wrap.innerHTML = `<label>Colour by <select>${cats.join('')}${nums.join('')}</select></label>`;
    side.appendChild(wrap);
    wrap.querySelector('select')!.addEventListener('change', ev => {
      const [k, field] = (ev.target as HTMLSelectElement).value.split(':');
      this.setColorBy(field, k === 'c' ? 'categorical' : 'numeric');
    });
  }

  protected setColorBy(field: string, kind: ColorKind): void {
    this.colorKind = kind;
    this.colorField = field;
    // A user-driven colour change repaints every loaded cell, not just a tail.
    this.canvas.setColorBy(field, kind, undefined, 0);
    this.updateLegend(true);
    this.syncColorPicker();
  }

  private async runQuery(shape: QueryShape): Promise<void> {
    try {
      // The worker only needs the coordinates it does not already have, and
      // it only needs them at the moment a query is actually asked.
      await this.client.ensure(this.store.xy, this.store.loadedCount);
      const indices = await this.client.query(shape, this.store.loadedCount);
      this.selectionStore.set(indices, shape.kind === 'poly' ? 'poly' : 'rect');
    } catch (err) {
      console.error('selection query failed', err);
    }
  }

  zoomToSelection(): void {
    const sel = this.selectionStore.current;
    if (sel) this.canvas.fitBounds(sel.bbox);
  }

  /** Called as chunks arrive so new cells get coloured and indexed. */
  onDataGrew(): void {
    this.canvas.refreshColors();
    // The selection worker is refreshed lazily, before the next query, rather
    // than on every chunk: the copy is eighty megabytes at ten million cells.
    this.updateLegend(this.store.isComplete());
    this.lod.setDrawn(this.canvas.drawnCount(), this.store.loadedCount);
  }

  destroy(): void {
    this.tooltip.destroy();
    this.lasso.destroy();
    this.client.terminate();
    this.canvas.destroy();
  }
}
