import { ScatterplotLayer } from '@deck.gl/layers';
import type { CellStore } from '@core/data/schema';
import { fetchCellInfo, type CellInfo } from '@core/data/cellInfo';
import { SelectionStore, type SelectionShape } from '@core/select/store';
import { SelectionClient } from '@core/select/client';
import type { QueryShape } from '@core/select/worker';
import { buildSelectionContext, type SelectionContext } from '@core/context/build';
import { defaultColorField } from '@core/color/defaults';
import { paletteFor } from '@core/color/palette';
import {
  CategoryFilter,
  computeVisibility,
  countVisible,
  filterIndices,
  hiddenLabels
} from '@core/filter/categories';
import type { OrganRegistry } from '@core/anatomy/registry';
import type { Rgb, Theme } from '@core/theme/themes';
import { ScatterCanvas, type ColorKind } from './ScatterCanvas';
import { LassoController } from '../interact/lasso';
import { ClickDetector } from '../interact/click';
import { createToolbar, type ToolbarHandle } from '../ui/Toolbar';
import { createLegend, type LegendHandle } from '../ui/Legend';
import { createLodControl, type LodHandle } from '../ui/LodControl';
import { createSelectionSummary, type SummaryHandle } from '../ui/SelectionSummary';
import { createRenderControl } from '../ui/RenderControl';
import { createInfoCard, type InfoCardHandle } from '../ui/InfoCard';
import { createSection } from '../ui/Section';
import { createAnatomyPanel, type AnatomyHandle } from '../anatomy/AnatomyPanel';
import { InsetController } from '../inset/InsetController';
import type { ThemeStore } from '../theme';
import { esc } from '../ui/escape';
import { API } from '../api';

export interface ScatterViewOptions {
  view?: 'embedding' | 'trajectory';
  themes: ThemeStore;
  registry: OrganRegistry;
  onContext?: (ctx: SelectionContext | null) => void;
  chat?: { setContext: (ctx: SelectionContext | null) => void };
}

const CLICK_CANDIDATES = 32;
const CLICK_WIDEN = 8;
const CLICK_CANDIDATES_MAX = 16_384;

/** Composes the canvas, worker, toolbar and panels; the store holds the raw selection ∩ visible. */
export class ScatterView {
  readonly canvas: ScatterCanvas;
  readonly selectionStore: SelectionStore;
  readonly filter: CategoryFilter;
  protected side: HTMLElement;
  protected holder: HTMLElement;
  protected extraPanel: HTMLElement;
  protected client = new SelectionClient();
  private lasso: LassoController;
  private clicks: ClickDetector;
  private toolbar: ToolbarHandle;
  private legend: LegendHandle;
  private lod: LodHandle;
  private summary: SummaryHandle;
  private card: InfoCardHandle | null = null;
  private anatomy: AnatomyHandle | null = null;
  private inset: InsetController | null = null;
  private insetAnatomy: AnatomyHandle | null = null;
  private colorField: string;
  private colorKind: ColorKind = 'categorical';
  private lastLegendUpdate = 0;
  private visible: Uint8Array | null = null;
  private visibleBuffer: Uint8Array | null = null;
  private legendBuffer: Uint8Array | null = null;
  private lastAnatomyRefresh = 0;
  private raw: { indices: Uint32Array; shape: SelectionShape } | null = null;
  private pickedCell: number | null = null;
  private clickSeq = 0;
  private selectionSeq = 0;
  private identity: { cell: number; info: CellInfo | null; pending: boolean } | null = null;
  private identityAbort: AbortController | null = null;
  private unsubscribe: (() => void)[] = [];

  constructor(
    root: HTMLElement,
    protected store: CellStore,
    protected opts: ScatterViewOptions
  ) {
    root.innerHTML = `<div class="canvas-holder"></div><aside class="side" aria-label="Controls"></aside>`;
    this.holder = root.querySelector<HTMLElement>('.canvas-holder')!;
    this.side = root.querySelector<HTMLElement>('.side')!;

    const initial = defaultColorField(store);
    this.colorField = initial?.field ?? '';
    this.colorKind = initial?.kind ?? 'categorical';
    this.selectionStore = new SelectionStore(store.n, store.xy);
    this.filter = new CategoryFilter(store.levels);

    this.toolbar = createToolbar(this.side, {
      onMode: m => this.lasso.setMode(m),
      onZoomToSelection: () => this.zoomToSelection(),
      onClear: () => this.clearSelection(),
      onResetView: () => this.canvas.fitBounds(store.bounds),
      onInset: () => this.inset?.toggle()
    });

    const colorBody = createSection(this.side, 'color', 'Color and legend');
    this.buildColorPicker(colorBody);
    this.legend = createLegend(colorBody, this.filter);

    const anatomyBody = createSection(this.side, 'anatomy', 'Anatomy');
    const selectionBody = createSection(this.side, 'selection', 'Selection');
    this.summary = createSelectionSummary(selectionBody);
    // Added after super() returns: a subclass's field initializers would otherwise reset these.
    this.extraPanel = document.createElement('div');
    this.extraPanel.style.display = 'contents';
    this.side.appendChild(this.extraPanel);
    const displayBody = createSection(this.side, 'display', 'Display');
    this.lod = createLodControl(displayBody, f => {
      this.canvas.setLod(f);
      this.lod.setDrawn(this.canvas.drawnCount(), store.loadedCount);
    });

    const theme = this.theme;
    this.canvas = new ScatterCanvas(this.holder, store, {
      theme,
      onViewStateChange: () => this.onViewChanged(),
      onInsetChange: () => this.onInsetChanged()
    });
    createRenderControl(displayBody, this.canvas.blending(), on => this.canvas.setBlending(on));

    this.card = createInfoCard(this.holder, {
      project: (x, y) => this.canvas.worldToScreen(x, y),
      onClose: () => this.clearPicked(),
      label: 'Cell details'
    });

    this.lasso = new LassoController(this.canvas, {
      onComplete: shape => void this.runQuery(shape),
      onCancel: () => this.canvas.setSelectionOverlay([]),
      previewColor: () => this.theme.selectionPreview
    });
    this.clicks = new ClickDetector(this.canvas.element(), (x, y) => this.handleClick(x, y));

    const anatomyCtx = {
      store,
      registry: opts.registry,
      visible: () => this.visible,
      selection: () => this.selectionStore.current,
      rawSelection: () => this.raw?.indices ?? null,
      select: (indices: Uint32Array | null) =>
        indices ? this.setRawSelection(indices, 'segment') : this.clearSelection(),
      theme: () => this.theme
    };
    this.anatomy = createAnatomyPanel(anatomyBody, anatomyCtx, {
      onPopOut: () => {
        this.inset?.show('anatomy');
        if (this.anatomy) this.insetAnatomy?.setState(this.anatomy.state());
      }
    });
    this.inset = new InsetController({
      host: this.holder,
      canvas: this.canvas,
      store,
      mountAnatomy: el => {
        this.insetAnatomy = createAnatomyPanel(el, anatomyCtx, { compact: true, initial: this.anatomy?.state() });
        return () => {
          this.insetAnatomy?.destroy();
          this.insetAnatomy = null;
        };
      },
      onOpenChange: open => this.toolbar.setInsetActive(open)
    });

    this.selectionStore.subscribe(sel => {
      this.canvas.applyMask(sel ? sel.mask : null);
      this.toolbar.setSelectionActive(sel !== null || this.raw !== null);
      this.refreshSelectionConsumers();
      this.anatomy?.refresh();
      this.insetAnatomy?.refresh();
    });
    this.unsubscribe.push(this.filter.subscribe(() => this.onFilterChanged()));
    this.unsubscribe.push(opts.themes.subscribe(t => this.applyTheme(t)));

    void this.client.ensure(store.xy, store.loadedCount);
    this.updateLegend(true);
    this.syncColorPicker();
    this.lod.setDrawn(this.canvas.drawnCount(), store.loadedCount);
    this.summary.update(null, 0);
  }

  protected get theme(): Theme {
    return this.opts.themes.current;
  }

  protected onThemeChanged(_theme: Theme): void {}

  private applyTheme(theme: Theme): void {
    this.canvas.setTheme(theme);
    this.updateLegend(true);
    if (this.pickedCell !== null) this.showCellCard(this.pickedCell);
    this.drawPickedRing();
    this.anatomy?.restyle();
    this.insetAnatomy?.restyle();
    this.onThemeChanged(theme);
  }

  private onViewChanged(): void {
    this.lod?.setDrawn(this.canvas.drawnCount(), this.store.loadedCount);
    this.card?.reposition();
    this.inset?.onViewChanged();
    this.repositionCards();
  }

  protected repositionCards(): void {}

  protected onInsetChanged(): void {}

  private syncColorPicker(): void {
    const select = this.side.querySelector<HTMLSelectElement>('.colorby select');
    if (!select || !this.colorField) return;
    select.value = `${this.colorKind === 'categorical' ? 'c' : 'n'}:${this.colorField}`;
  }

  private updateLegend(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastLegendUpdate < 200) return;
    this.lastLegendUpdate = now;
    const others =
      this.colorKind === 'categorical' && this.colorField
        ? computeVisibility(this.store, this.filter, this.legendBuffer ?? undefined, this.colorField)
        : null;
    if (others) this.legendBuffer = others;
    this.legend.update(this.store, this.colorField, this.colorKind, others, this.theme.background);
  }

  private buildColorPicker(root: HTMLElement): void {
    const wrap = document.createElement('div');
    wrap.className = 'colorby';
    const cats = this.store.categoricalFields().map(f => `<option value="c:${esc(f)}">${esc(f)}</option>`);
    const nums = this.store.numericFields().map(f => `<option value="n:${esc(f)}">${esc(f)}</option>`);
    wrap.innerHTML = `<label>Color by <select>${cats.join('')}${nums.join('')}</select></label>`;
    root.appendChild(wrap);
    wrap.querySelector('select')!.addEventListener('change', ev => {
      const value = (ev.target as HTMLSelectElement).value;
      const sep = value.indexOf(':');
      this.setColorBy(value.slice(sep + 1), value.slice(0, sep) === 'c' ? 'categorical' : 'numeric');
    });
  }

  protected setColorBy(field: string, kind: ColorKind): void {
    this.colorKind = kind;
    this.colorField = field;
    this.canvas.setColorBy(field, kind, undefined, 0);
    this.updateLegend(true);
    this.syncColorPicker();
    this.refreshSelectionConsumers();
    if (this.pickedCell !== null) this.showCellCard(this.pickedCell);
  }

  private onFilterChanged(): void {
    this.visible = computeVisibility(this.store, this.filter, this.visibleBuffer ?? undefined);
    if (this.visible) this.visibleBuffer = this.visible;
    // Re-derive the effective selection from the raw one so un-hiding a category restores its cells.
    const effective = this.raw ? filterIndices(this.raw.indices, this.visible) : null;
    const selectionChanges = effective !== null && effective !== this.selectionStore.current?.indices;
    this.canvas.setVisibility(this.visible, !selectionChanges);
    this.updateLegend(true);
    if (this.pickedCell !== null && this.visible && !this.visible[this.pickedCell]) this.clearPicked();
    if (selectionChanges) this.publishSelection();
    else {
      this.refreshSelectionConsumers();
      this.anatomy?.refresh();
      this.insetAnatomy?.refresh();
    }
  }

  private refreshSelectionConsumers(): void {
    const sel = this.selectionStore.current;
    const ctx = sel
      ? buildSelectionContext(this.store, sel, {
          datasetId: this.store.datasetId,
          view: this.opts.view ?? 'embedding',
          colorBy: this.colorField,
          visibleN: countVisible(this.visible, this.store.loadedCount),
          hidden: hiddenLabels(this.filter, this.store.levels)
        })
      : null;
    this.summary.update(ctx, this.client.lastQueryMs);
    this.opts.chat?.setContext(ctx);
    this.opts.onContext?.(ctx);
  }

  private setRawSelection(indices: Uint32Array, shape: SelectionShape): void {
    this.selectionSeq++;
    this.raw = indices.length ? { indices, shape } : null;
    this.publishSelection();
  }

  private publishSelection(): void {
    if (!this.raw) {
      this.selectionStore.clear();
      return;
    }
    const effective = filterIndices(this.raw.indices, this.visible);
    if (effective.length) this.selectionStore.set(effective, this.raw.shape);
    else this.selectionStore.clear();
    this.toolbar.setSelectionActive(true);
  }

  private clearSelection(): void {
    this.selectionSeq++;
    this.raw = null;
    this.selectionStore.clear();
  }

  private async runQuery(shape: QueryShape): Promise<void> {
    const seq = ++this.selectionSeq;
    try {
      await this.client.ensure(this.store.xy, this.store.loadedCount);
      const indices = await this.client.query(shape, this.store.loadedCount);
      if (seq !== this.selectionSeq) return;
      this.setRawSelection(indices, shape.kind === 'poly' ? 'poly' : 'rect');
    } catch (err) {
      console.error('selection query failed', err);
    }
  }

  protected handleClick(x: number, y: number): void {
    void this.pickCell(x, y);
  }

  protected clickRadiusWorld(extraPx = 3): number {
    const px = Math.max(5, this.canvas.pointRadius() + extraPx);
    return px / Math.pow(2, this.canvas.viewState.zoom);
  }

  private async pickCell(x: number, y: number): Promise<void> {
    const seq = ++this.clickSeq;
    const [wx, wy] = this.canvas.screenToWorld(x, y);
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;
    try {
      await this.client.ensure(this.store.xy, this.store.loadedCount);
      const radius = this.clickRadiusWorld();
      let hit: number | null = null;
      for (let k = CLICK_CANDIDATES; ; k *= CLICK_WIDEN) {
        const candidates = await this.client.nearest({ x: wx, y: wy, radius, k }, this.canvas.drawnCount());
        if (seq !== this.clickSeq) return;
        const vis = this.visible;
        for (const i of candidates) {
          if (!vis || vis[i]) {
            hit = i;
            break;
          }
        }
        if (hit !== null || candidates.length < k || k >= CLICK_CANDIDATES_MAX) break;
      }
      if (hit === null) {
        this.clearPicked();
      } else {
        this.showCellCard(hit);
        void this.lookUpIdentity(hit, seq);
      }
    } catch (err) {
      console.error('cell lookup failed', err);
    }
  }

  private async lookUpIdentity(i: number, seq: number): Promise<void> {
    this.identityAbort?.abort();
    const abort = new AbortController();
    this.identityAbort = abort;
    this.identity = { cell: i, info: null, pending: true };
    let info: CellInfo | null;
    try {
      info = await fetchCellInfo(API, this.store.datasetId, i, this.store.version, abort.signal);
    } catch {
      return;
    }
    if (seq !== this.clickSeq || this.pickedCell !== i) return;
    this.identity = { cell: i, info, pending: false };
    this.showCellCard(i);
  }

  private showCellCard(i: number): void {
    this.pickedCell = i;
    const s = this.store;
    const rows: string[] = [];
    const known = this.identity?.cell === i ? this.identity : null;
    if (known?.pending) {
      rows.push(`<dt>source row</dt><dd class="muted">looking up…</dd>`);
    } else if (known?.info?.row != null) {
      rows.push(`<dt>source row</dt><dd>${known.info.row}</dd>`);
    } else {
      rows.push(`<dt>viewer index</dt><dd>${i}</dd>`);
    }
    for (const [field, codes] of s.codes) {
      const labels = s.levels.get(field)!;
      const code = codes[i] % Math.max(1, labels.length);
      let swatch = '';
      if (field === this.colorField && this.colorKind === 'categorical') {
        const p = paletteFor(labels.length, this.theme.background);
        swatch = `<span class="swatch" style="background:rgb(${p[code * 3]},${p[code * 3 + 1]},${p[code * 3 + 2]})"></span>`;
      }
      rows.push(`<dt>${esc(field)}</dt><dd>${swatch}${esc(labels[code] ?? '—')}</dd>`);
    }
    for (const [field, values] of s.numeric) {
      rows.push(`<dt>${esc(field)}</dt><dd>${values[i].toFixed(3)}</dd>`);
    }
    rows.push(`<dt>position</dt><dd>${s.xy[i * 2].toFixed(2)}, ${s.xy[i * 2 + 1].toFixed(2)}</dd>`);
    const title = known?.info?.id || 'Cell';
    this.card?.show(title, `<dl>${rows.join('')}</dl>`, [s.xy[i * 2], s.xy[i * 2 + 1]]);
    this.drawPickedRing();
  }

  private drawPickedRing(): void {
    if (this.pickedCell === null) {
      this.canvas.setOverlay('picked', []);
      return;
    }
    const i = this.pickedCell;
    const ring: Rgb = this.theme.ring;
    this.canvas.setOverlay('picked', [
      new ScatterplotLayer({
        id: 'picked-ring',
        data: [[this.store.xy[i * 2], this.store.xy[i * 2 + 1]]],
        getPosition: (d: [number, number]) => d,
        getRadius: this.canvas.pointRadius() + 5,
        radiusUnits: 'pixels',
        filled: false,
        stroked: true,
        getLineColor: [ring[0], ring[1], ring[2], 255],
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        pickable: false
      })
    ]);
  }

  protected clearPicked(): void {
    this.clickSeq++;
    this.identityAbort?.abort();
    this.identityAbort = null;
    this.identity = null;
    this.pickedCell = null;
    this.card?.hide();
    this.canvas.setOverlay('picked', []);
  }

  zoomToSelection(): void {
    const sel = this.selectionStore.current;
    if (sel) this.canvas.fitBounds(sel.bbox);
  }

  onDataGrew(): void {
    if (this.filter.isActive()) {
      this.visible = computeVisibility(this.store, this.filter, this.visibleBuffer ?? undefined);
      this.canvas.setVisibility(this.visible);
    } else {
      this.canvas.refreshColors();
    }
    // The worker is refreshed lazily before a query, not per chunk (80 MB at ten million cells).
    this.updateLegend(this.store.isComplete());
    this.lod.setDrawn(this.canvas.drawnCount(), this.store.loadedCount);
    const now = Date.now();
    if (this.store.isComplete() || now - this.lastAnatomyRefresh > 250) {
      this.lastAnatomyRefresh = now;
      this.anatomy?.refresh();
      this.insetAnatomy?.refresh();
    }
  }

  destroy(): void {
    for (const off of this.unsubscribe) off();
    this.identityAbort?.abort();
    this.clicks.destroy();
    this.card?.destroy();
    this.inset?.destroy();
    this.anatomy?.destroy();
    this.lasso.destroy();
    this.client.terminate();
    this.canvas.destroy();
  }
}
