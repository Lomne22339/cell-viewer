import type { CellStore } from '@core/data/schema';
import type { Selection } from '@core/select/store';
import type { OrganRegistry } from '@core/anatomy/registry';
import type { OrganModel } from '@core/anatomy/types';
import { chooseField, matchLevels, organScope, type LevelMatch } from '@core/anatomy/match';
import { cellsInSegments, segmentCounts } from '@core/anatomy/stats';
import type { Theme } from '@core/theme/themes';
import { renderOrgan, type FigureHandle } from './figure';
import { esc } from '../ui/escape';

export interface AnatomyContext {
  store: CellStore;
  registry: OrganRegistry;
  /** Legend-filter visibility; hidden cells never count and are never selected. */
  visible: () => Uint8Array | null;
  selection: () => Selection | null;
  rawSelection: () => Uint32Array | null;
  select: (indices: Uint32Array | null) => void;
  theme: () => Theme;
}

export interface AnatomyOptions {
  compact?: boolean;
  onPopOut?: () => void;
  initial?: AnatomyState;
}

export interface AnatomyState {
  trail: string[];
  override: [string, string][];
}

/** A double-click must not first act as a click (Plotly uses 300 ms). */
const DOUBLE_CLICK_MS = 300;

export interface AnatomyHandle {
  state: () => AnatomyState;
  setState: (state: AnatomyState) => void;
  refresh: () => void;
  restyle: () => void;
  showModel: (id: string) => void;
  destroy: () => void;
}

function heat(theme: Theme, t: number): string {
  const stops = theme.heat;
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c.join(',')})`;
}

function gradient(theme: Theme): string {
  const stops = theme.heat;
  return `linear-gradient(90deg, ${stops.map(s => `rgb(${s.join(',')})`).join(', ')})`;
}

/** Segmented anatomy: regions shaded by where cells come from; clicking one selects its cells. */
export function createAnatomyPanel(
  root: HTMLElement,
  ctx: AnatomyContext,
  opts: AnatomyOptions = {}
): AnatomyHandle {
  const box = document.createElement('div');
  box.className = `anatomy${opts.compact ? ' anatomy-compact' : ''}`;
  root.appendChild(box);

  const models = ctx.registry.list();
  const categorical = ctx.store.categoricalFields().map(name => ({
    name,
    levels: ctx.store.levels.get(name) ?? []
  }));
  const autoMatch = new Map<string, { field: string; match: LevelMatch } | null>();
  for (const m of models) autoMatch.set(m.id, chooseField(m, categorical));
  const override = new Map<string, string>(
    (opts.initial?.override ?? []).filter(([m, f]) => ctx.registry.has(m) && ctx.store.codes.has(f))
  );

  const initialTrail = opts.initial?.trail.filter(id => ctx.registry.has(id)) ?? [];
  let trail: string[] = initialTrail.length
    ? initialTrail
    : [
        (models.find(m => m.id === 'body' && autoMatch.get(m.id)) ?? models.find(m => autoMatch.get(m.id)) ?? models[0])
          ?.id ?? ''
      ];
  let pendingClick: ReturnType<typeof setTimeout> | null = null;
  let figure: FigureHandle | null = null;
  let selected = new Set<number>();
  let ownIndices: Uint32Array | null = null;
  let counts: Uint32Array = new Uint32Array(0);
  let reached: Uint8Array = new Uint8Array(0);
  let scopeTotal = 0;
  let scopeIsSelection = false;
  let hover: number | null = null;

  box.innerHTML =
    (opts.compact ? '' : `<div class="anatomy-tabs" role="tablist" aria-label="Organ"></div>`) +
    `<div class="anatomy-crumbs"></div>` +
    `<div class="anatomy-figure"><div class="anatomy-tip" hidden></div></div>` +
    `<div class="anatomy-scale"><span>0</span><span class="bar"></span><span class="max">max</span>` +
    `<span class="nodata" title="No matching annotation in this dataset"></span><span>no data</span></div>` +
    `<div class="anatomy-actions"></div>` +
    (opts.compact ? '' : `<label class="field-select muted">Region field <select></select></label>`);

  const tabs = box.querySelector<HTMLElement>('.anatomy-tabs');
  const crumbs = box.querySelector<HTMLElement>('.anatomy-crumbs')!;
  const figHost = box.querySelector<HTMLElement>('.anatomy-figure')!;
  const tip = box.querySelector<HTMLElement>('.anatomy-tip')!;
  const scaleBar = box.querySelector<HTMLElement>('.anatomy-scale .bar')!;
  const scaleMax = box.querySelector<HTMLElement>('.anatomy-scale .max')!;
  const actions = box.querySelector<HTMLElement>('.anatomy-actions')!;
  const fieldSelect = box.querySelector<HTMLSelectElement>('.field-select select');

  const model = (): OrganModel | undefined => ctx.registry.get(trail[trail.length - 1]);

  const matchFor = (m: OrganModel): { field: string; match: LevelMatch } | null => {
    const chosen = override.get(m.id);
    if (chosen) return { field: chosen, match: matchLevels(m, ctx.store.levels.get(chosen) ?? []) };
    return autoMatch.get(m.id) ?? null;
  };

  const renderTabs = (): void => {
    if (!tabs) return;
    const current = trail[0];
    tabs.innerHTML = models
      .map(
        m =>
          `<button class="btn btn-small${m.id === current ? ' active' : ''}" role="tab" ` +
          `aria-selected="${m.id === current}" data-model="${esc(m.id)}"` +
          `${autoMatch.get(m.id) ? '' : ' title="No matching annotation in this dataset"'}>${esc(m.label)}</button>`
      )
      .join('');
  };

  const renderCrumbs = (): void => {
    crumbs.innerHTML = trail
      .map((id, i) => {
        const label = esc(ctx.registry.get(id)?.label ?? id);
        return i < trail.length - 1 ? `<button data-crumb="${i}">${label}</button> ›` : `<span>${label}</span>`;
      })
      .join(' ');
    const m = model();
    if (m) crumbs.insertAdjacentHTML('beforeend', ` <span class="muted">· ${esc(m.view)}</span>`);
  };

  const renderFieldSelect = (): void => {
    if (!fieldSelect) return;
    const m = model();
    if (!m) return;
    const auto = autoMatch.get(m.id);
    const current = override.get(m.id) ?? '';
    fieldSelect.innerHTML =
      `<option value="">auto${auto ? ` (${esc(auto.field)})` : ' (none matches)'}</option>` +
      categorical
        .map(f => `<option value="${esc(f.name)}"${f.name === current ? ' selected' : ''}>${esc(f.name)}</option>`)
        .join('');
  };

  const renderActions = (): void => {
    const m = model();
    const parts: string[] = [];
    if (selected.size) parts.push(`<button class="btn btn-small" data-act="clear">Clear region selection</button>`);
    if (m && selected.size === 1) {
      const seg = m.segments[[...selected][0]];
      if (seg.drillDown && ctx.registry.has(seg.drillDown)) {
        parts.push(
          `<button class="btn btn-small" data-act="drill" data-target="${esc(seg.drillDown)}">` +
            `Open ${esc(ctx.registry.get(seg.drillDown)!.label)} ›</button>`
        );
      }
    }
    if (opts.onPopOut) parts.push(`<button class="btn btn-small" data-act="popout">Show in plot</button>`);
    const match = m ? matchFor(m) : null;
    parts.push(
      `<span class="muted">${
        match
          ? `${scopeTotal.toLocaleString()} ${scopeIsSelection ? 'selected' : 'visible'} cells map to ${esc(m!.label.toLowerCase())} via “${esc(match.field)}”`
          : 'No field in this dataset names these regions'
      }</span>`
    );
    actions.innerHTML = parts.join('');
  };

  const showTip = (): void => {
    const m = model();
    if (hover === null || !m || hover >= m.segments.length) {
      tip.hidden = true;
      return;
    }
    const seg = m.segments[hover];
    const has = reached[hover] === 1;
    const n = counts[hover] ?? 0;
    const share = scopeTotal ? ((n / scopeTotal) * 100).toFixed(1) : '0.0';
    tip.innerHTML = has
      ? `<b>${esc(seg.label)}</b> · ${n.toLocaleString()} cells · ${share}%${seg.drillDown ? ' · double-click to open' : ''}`
      : `<b>${esc(seg.label)}</b> · no matching cells in this dataset`;
    tip.hidden = false;
  };

  const paint = (): void => {
    const theme = ctx.theme();
    let max = 0;
    for (let s = 0; s < counts.length; s++) if (counts[s] > max) max = counts[s];
    figure?.setFills(s => (reached[s] ? heat(theme, max ? counts[s] / max : 0) : null));
    figure?.setSelected(selected);
    scaleBar.style.background = gradient(theme);
    scaleMax.textContent = max && scopeTotal ? `${((max / scopeTotal) * 100).toFixed(0)}%` : 'max';
  };

  const withinFor = (m: OrganModel, regionField: string): { codes: Uint16Array; levels: Uint8Array } | null => {
    const scope = organScope(m, categorical, regionField);
    const codes = scope ? ctx.store.codes.get(scope.field) : undefined;
    return scope && codes ? { codes, levels: scope.levels } : null;
  };

  const compute = (): void => {
    const m = model();
    const match = m ? matchFor(m) : null;
    if (!m || !match) {
      counts = new Uint32Array(m?.segments.length ?? 0);
      reached = new Uint8Array(m?.segments.length ?? 0);
      scopeTotal = 0;
      return;
    }
    const codes = ctx.store.codes.get(match.field)!;
    reached = new Uint8Array(m.segments.length);
    for (const s of match.match.levelToSegment) if (s >= 0) reached[s] = 1;
    const sel = ctx.selection();
    scopeIsSelection = sel !== null;
    counts = segmentCounts(codes, match.match.levelToSegment, m.segments.length, {
      upTo: ctx.store.loadedCount,
      indices: sel?.indices ?? null,
      visible: ctx.visible(),
      within: withinFor(m, match.field)
    });
    scopeTotal = 0;
    for (const c of counts) scopeTotal += c;
  };

  const selectSegments = (): void => {
    const m = model();
    const match = m ? matchFor(m) : null;
    if (!m || !match || selected.size === 0) {
      ownIndices = null;
      ctx.select(null);
      return;
    }
    const codes = ctx.store.codes.get(match.field)!;
    // The raw selection is every region cell, hidden or not; the view applies the legend filter.
    ownIndices = cellsInSegments(
      codes,
      match.match.levelToSegment,
      selected,
      ctx.store.loadedCount,
      null,
      withinFor(m, match.field)
    );
    ctx.select(ownIndices.length ? ownIndices : null);
  };

  const releaseOwnSelection = (): void => {
    if (pendingClick) {
      clearTimeout(pendingClick);
      pendingClick = null;
    }
    if (ownIndices && ctx.rawSelection() === ownIndices) {
      selected = new Set();
      ownIndices = null;
      ctx.select(null);
    }
    selected = new Set();
  };

  const mountFigure = (): void => {
    figure?.destroy();
    const m = model();
    if (!m) return;
    figure = renderOrgan(m, {
      onHover: s => {
        hover = s;
        showTip();
      },
      onClick: (s, ev) => {
        const additive = ev.shiftKey || ev.metaKey || ev.ctrlKey;
        const apply = (): void => {
          if (additive) {
            if (selected.has(s)) selected.delete(s);
            else selected.add(s);
          } else if (selected.size === 1 && selected.has(s)) {
            selected = new Set();
          } else {
            selected = new Set([s]);
          }
          selectSegments();
          renderActions();
          figure?.setSelected(selected);
        };
        if (pendingClick) {
          clearTimeout(pendingClick);
          pendingClick = null;
        }
        const detail = ev instanceof MouseEvent ? ev.detail : 0;
        if (detail >= 2) return;
        const seg = model()?.segments[s];
        if (detail === 0 || !seg?.drillDown || !ctx.registry.has(seg.drillDown)) {
          apply();
          return;
        }
        pendingClick = setTimeout(() => {
          pendingClick = null;
          apply();
        }, DOUBLE_CLICK_MS);
      },
      onDoubleClick: s => {
        if (pendingClick) {
          clearTimeout(pendingClick);
          pendingClick = null;
        }
        const seg = model()?.segments[s];
        if (seg?.drillDown && ctx.registry.has(seg.drillDown)) drill(seg.drillDown);
      }
    });
    figHost.insertBefore(figure.el, tip);
  };

  const fullRender = (): void => {
    hover = null;
    tip.hidden = true;
    renderTabs();
    renderCrumbs();
    renderFieldSelect();
    mountFigure();
    compute();
    paint();
    renderActions();
  };

  const drill = (id: string): void => {
    trail = [...trail, id];
    selected = new Set();
    fullRender();
  };

  box.addEventListener('click', ev => {
    const t = ev.target as HTMLElement;
    const tab = t.closest<HTMLButtonElement>('[data-model]');
    if (tab) {
      handle.showModel(tab.dataset.model!);
      return;
    }
    const crumb = t.closest<HTMLButtonElement>('[data-crumb]');
    if (crumb) {
      releaseOwnSelection();
      trail = trail.slice(0, Number(crumb.dataset.crumb) + 1);
      fullRender();
      return;
    }
    const act = t.closest<HTMLButtonElement>('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'clear') {
      selected = new Set();
      selectSegments();
      renderActions();
      figure?.setSelected(selected);
    } else if (act.dataset.act === 'drill') {
      drill(act.dataset.target!);
    } else if (act.dataset.act === 'popout') {
      opts.onPopOut?.();
    }
  });
  fieldSelect?.addEventListener('change', () => {
    const m = model();
    if (!m) return;
    if (fieldSelect.value) override.set(m.id, fieldSelect.value);
    else override.delete(m.id);
    releaseOwnSelection();
    compute();
    paint();
    renderActions();
  });

  const handle: AnatomyHandle = {
    refresh() {
      if (selected.size && ctx.rawSelection() !== ownIndices) {
        selected = new Set();
        ownIndices = null;
      }
      compute();
      paint();
      renderActions();
      showTip();
    },
    restyle: paint,
    showModel(id) {
      if (!ctx.registry.has(id)) return;
      releaseOwnSelection();
      trail = [id];
      fullRender();
    },
    state: () => ({ trail: [...trail], override: [...override.entries()] }),
    setState(next) {
      const t = next.trail.filter(id => ctx.registry.has(id));
      if (!t.length) return;
      trail = t;
      override.clear();
      for (const [m, f] of next.override) if (ctx.registry.has(m) && ctx.store.codes.has(f)) override.set(m, f);
      selected = new Set();
      fullRender();
    },
    destroy() {
      if (pendingClick) clearTimeout(pendingClick);
      figure?.destroy();
      box.remove();
    }
  };

  fullRender();
  return handle;
}
