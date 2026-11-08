import { fetchGraph, fetchManifest, loadDataset } from '@core/data/loader';
import type { OrganRegistry } from '@core/anatomy/registry';
import { connectorPath } from '@core/organ/connector';
import { linkSelections, type SelectionPort } from '@core/organ/link';
import {
  ORGAN_VIEW_ORGANS,
  bodySegmentFor,
  isOrganDataset,
  organDatasetIds,
  organLabel,
  organsTopToBottom,
  type OrganViewOrgan
} from '@core/organ/organs';
import { createAnatomyPanel, type AnatomyContext, type AnatomyHandle } from '../anatomy/AnatomyPanel';
import { renderOrgan, type FigureHandle } from '../anatomy/figure';
import type { ThemeStore } from '../theme';
import { esc } from '../ui/escape';
import { ScatterView } from '../views/ScatterView';
import { TrajectoryView } from '../views/TrajectoryView';

export interface OrganViewOptions {
  api: string;
  themes: ThemeStore;
  registry: OrganRegistry;
  setStatus: (text: string) => void;
}

export interface OrganViewHandle {
  selected: () => OrganViewOrgan | null;
  /** Opens an organ (null returns to the overview). Resolves once its data has loaded. */
  select: (organ: string | null) => Promise<void>;
  readonly umap: ScatterView | null;
  readonly trajectory: TrajectoryView | null;
  readonly anatomy: AnatomyHandle | null;
  destroy: () => void;
}

/**
 * Makes a figure a picture only. A thumbnail inside a button is the button's
 * icon: its parts must not be separate tab stops or targets, and their names
 * (each part's `<title>`) must not become the button's accessible name.
 */
function decorative(fig: FigureHandle): FigureHandle {
  fig.el.setAttribute('aria-hidden', 'true');
  fig.el.setAttribute('inert', '');
  fig.el.querySelectorAll('title').forEach(t => t.remove());
  return fig;
}

const isOrgan = (id: string): id is OrganViewOrgan => (ORGAN_VIEW_ORGANS as readonly string[]).includes(id);

/** Runs `fn` at most once per frame while `el` changes size. A canvas does not notice that on its own. */
function observeResize(el: HTMLElement, fn: () => void): () => void {
  let frame = 0;
  const ro = new ResizeObserver(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      fn();
    });
  });
  ro.observe(el);
  return () => {
    ro.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}

/** A view's selection as the link sees it. */
function portOf(view: ScatterView): SelectionPort {
  return {
    subscribe: cb => view.selectionStore.subscribe(sel => cb(sel ? sel.indices : null)),
    apply: indices => view.selectIndices(indices)
  };
}

/**
 * The Organ View: a human body with three organs, and for the organ you pick,
 * its parts with the UMAP and trajectory of that organ's cells.
 *
 * Nothing here is new drawing code. The body and organ figures are the anatomy
 * figures; choosing a part is the anatomy panel; the two plots are the
 * `ScatterView` and `TrajectoryView` the dashboard uses. What this adds is the
 * arrangement, and one link: the two plots hold the same cells in the same
 * order, so a part chosen on the figure, or a lasso on either plot, selects
 * the same cells in both and in the figure's shading.
 *
 * The organ datasets are simulated, and the view says so wherever it shows
 * them (the manifest's `meta.synthetic`).
 */
export async function createOrganView(root: HTMLElement, opts: OrganViewOptions): Promise<OrganViewHandle> {
  const { api, themes, registry } = opts;
  const body = registry.get('body');
  const bodySegs = new Map<OrganViewOrgan, number>();
  if (body) for (const o of ORGAN_VIEW_ORGANS) bodySegs.set(o, bodySegmentFor(body, o));
  // Cards run top to bottom as the organs sit on the body, so no line crosses another.
  const cardOrder = (body ? organsTopToBottom(body, ORGAN_VIEW_ORGANS) : [...ORGAN_VIEW_ORGANS]) as OrganViewOrgan[];

  root.innerHTML =
    `<div class="ov" data-organ="">` +
    `<div class="pc-bar ov-bar"><span class="pc-badge" hidden></span>` +
    `<button class="btn btn-small ov-back" hidden>◀ All organs</button>` +
    `<strong class="ov-title">Organ view</strong><span class="ov-summary" aria-live="polite"></span></div>` +
    `<div class="ov-overview"></div><div class="ov-detail" hidden></div></div>`;
  const view = root.querySelector<HTMLElement>('.ov')!;
  const badge = root.querySelector<HTMLElement>('.pc-badge')!;
  const back = root.querySelector<HTMLButtonElement>('.ov-back')!;
  const title = root.querySelector<HTMLElement>('.ov-title')!;
  const summary = root.querySelector<HTMLElement>('.ov-summary')!;
  const overview = root.querySelector<HTMLElement>('.ov-overview')!;
  const detail = root.querySelector<HTMLElement>('.ov-detail')!;

  let current: OrganViewOrgan | null = null;
  let openSeq = 0;
  let abort: AbortController | null = null;
  let destroyed = false;
  let umap: ScatterView | null = null;
  let trajectory: TrajectoryView | null = null;
  let anatomy: AnatomyHandle | null = null;
  const detailCleanup: (() => void)[] = [];
  const overviewCleanup: (() => void)[] = [];

  const setBadge = (synthetic: boolean): void => {
    badge.hidden = !synthetic;
    badge.textContent = 'Synthetic demo data';
    badge.title = 'These cells and their embeddings are simulated placeholders, not measurements.';
  };

  // ---- which organ datasets the server has ----------------------------------
  let available = new Set<string>();
  try {
    const res = await fetch(`${api}/api/datasets`);
    if (res.ok) available = new Set(((await res.json()) as { datasets: string[] }).datasets.filter(isOrganDataset));
  } catch {
    /* the cards say the data is missing */
  }
  if (destroyed) return handle();
  const hasData = (o: OrganViewOrgan): boolean => {
    const ids = organDatasetIds(o);
    return available.has(ids.umap) && available.has(ids.trajectory);
  };
  // The overview already labels itself synthetic whenever it offers organ data.
  setBadge([...ORGAN_VIEW_ORGANS].some(hasData));

  // ---- overview -------------------------------------------------------------
  function buildOverview(): void {
    for (const fn of overviewCleanup.splice(0)) fn();
    const missing = ORGAN_VIEW_ORGANS.filter(o => !hasData(o));
    overview.innerHTML =
      `<div class="ov-overview-inner">` +
      `<div class="ov-body" role="group" aria-label="Human body"></div>` +
      `<svg class="ov-links" aria-hidden="true"></svg>` +
      `<div class="ov-cards">` +
      cardOrder.map(o => {
        const m = registry.get(o);
        return (
          `<button class="ov-card" data-organ="${o}"${hasData(o) ? '' : ' disabled'}>` +
          `<span class="ov-card-fig"></span><span class="ov-card-text"><b>${esc(organLabel(registry, o))}</b>` +
          `<span class="muted">${m ? m.segments.length : 0} parts · UMAP and trajectory</span></span></button>`
        );
      }).join('') +
      `</div>` +
      (missing.length
        ? `<p class="ov-missing" role="status">No organ datasets for ${esc(missing.join(', '))}. Build them with ` +
          `<code>python -m server.prep --sizes --traj-size 0 --organ-size 30000</code>.</p>`
        : `<p class="ov-hint muted">Pick an organ on the body or from the list to see its parts, UMAP and trajectory.</p>`) +
      `</div>`;

    const inner = overview.querySelector<HTMLElement>('.ov-overview-inner')!;
    const links = overview.querySelector<SVGSVGElement>('.ov-links')!;
    let bodyFig: FigureHandle | null = null;
    const organAtSegment = new Map<number, OrganViewOrgan>();
    for (const [o, s] of bodySegs) if (s >= 0) organAtSegment.set(s, o);

    if (body) {
      bodyFig = renderOrgan(body, {
        onClick: s => {
          const o = organAtSegment.get(s);
          if (o && hasData(o)) void select(o);
        },
        onHover: s => {
          const o = s === null ? undefined : organAtSegment.get(s);
          inner.dataset.hot = o ?? '';
          bodyFig?.setSelected(new Set(o ? [bodySegs.get(o)!] : []));
          drawLinks();
        }
      });
      bodyFig.setFills(s => (organAtSegment.has(s) ? 'var(--accent)' : 'var(--organ-base)'));
      inner.querySelector('.ov-body')!.appendChild(bodyFig.el);
      overviewCleanup.push(() => bodyFig?.destroy());
    }
    for (const card of inner.querySelectorAll<HTMLButtonElement>('.ov-card')) {
      const o = card.dataset.organ as OrganViewOrgan;
      const m = registry.get(o);
      if (m) {
        const fig = decorative(renderOrgan(m));
        fig.setFills(() => 'var(--organ-base)');
        card.querySelector('.ov-card-fig')!.appendChild(fig.el);
        overviewCleanup.push(() => fig.destroy());
      }
      card.addEventListener('click', () => void select(o));
      const hot = (on: boolean): void => {
        inner.dataset.hot = on ? o : '';
        bodyFig?.setSelected(new Set(on && bodySegs.get(o)! >= 0 ? [bodySegs.get(o)!] : []));
        drawLinks();
      };
      card.addEventListener('pointerenter', () => hot(true));
      card.addEventListener('pointerleave', () => hot(false));
      card.addEventListener('focus', () => hot(true));
      card.addEventListener('blur', () => hot(false));
    }

    /** Joins each organ's place on the body to its card. */
    function drawLinks(): void {
      const box = inner.getBoundingClientRect();
      if (box.width === 0) return;
      links.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
      const parts: string[] = [];
      for (const o of ORGAN_VIEW_ORGANS) {
        const seg = inner.querySelector<SVGElement>(`.ov-body [data-seg="${o}"]`);
        const card = inner.querySelector<HTMLElement>(`.ov-card[data-organ="${o}"]`);
        if (!seg || !card) continue;
        const a = seg.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        const from: [number, number] = [a.x + a.width / 2 - box.x, a.y + a.height / 2 - box.y];
        const to: [number, number] = [c.x - box.x, c.y + c.height / 2 - box.y];
        const hotClass = inner.dataset.hot === o ? ' hot' : '';
        parts.push(
          `<path class="ov-link${hotClass}" data-organ="${o}" d="${connectorPath(from, to)}"/>` +
            `<circle class="ov-dot${hotClass}" cx="${from[0]}" cy="${from[1]}" r="4"/>`
        );
      }
      links.innerHTML = parts.join('');
    }
    drawLinks();
    overviewCleanup.push(observeResize(inner, drawLinks));
  }

  // ---- detail: one organ, maximised -----------------------------------------
  function teardownDetail(): void {
    for (const fn of detailCleanup.splice(0).reverse()) fn();
    anatomy = null;
    umap = null;
    trajectory = null;
    detail.innerHTML = '';
  }

  /** The rail: the body and the three organs as small, clickable figures. */
  function buildRail(organ: OrganViewOrgan): HTMLElement {
    const rail = document.createElement('aside');
    rail.className = 'ov-rail';
    rail.setAttribute('aria-label', 'Organs');
    const item = (key: string, label: string, pressed: boolean): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = 'ov-rail-item';
      b.dataset.nav = key;
      b.setAttribute('aria-pressed', String(pressed));
      b.innerHTML = `<span class="ov-rail-fig"></span><span>${esc(label)}</span>`;
      rail.appendChild(b);
      return b;
    };
    if (body) {
      const b = item('overview', 'Body', false);
      b.title = 'Back to the body and all three organs';
      const fig = decorative(renderOrgan(body));
      fig.setFills(s => (s === bodySegs.get(organ) ? 'var(--accent)' : 'var(--organ-base)'));
      b.querySelector('.ov-rail-fig')!.appendChild(fig.el);
      detailCleanup.push(() => fig.destroy());
    }
    for (const o of ORGAN_VIEW_ORGANS) {
      const m = registry.get(o);
      const b = item(o, organLabel(registry, o), o === organ);
      b.disabled = !hasData(o);
      if (o === organ) b.setAttribute('aria-current', 'true');
      if (m) {
        const fig = decorative(renderOrgan(m));
        fig.setFills(() => (o === organ ? 'var(--accent)' : 'var(--organ-base)'));
        b.querySelector('.ov-rail-fig')!.appendChild(fig.el);
        detailCleanup.push(() => fig.destroy());
      }
    }
    rail.addEventListener('click', ev => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-nav]');
      if (!btn || btn.disabled) return;
      void select(btn.dataset.nav === 'overview' ? null : btn.dataset.nav!);
    });
    return rail;
  }

  function panel(heading: string): { el: HTMLElement; body: HTMLElement; extra: HTMLElement } {
    const el = document.createElement('section');
    el.className = 'pg-panel';
    el.innerHTML = `<header class="pg-head"><h2>${esc(heading)}</h2><span class="pg-extra"></span></header><div class="pg-body"></div>`;
    return { el, body: el.querySelector('.pg-body')!, extra: el.querySelector('.pg-extra')! };
  }

  async function openOrgan(organ: OrganViewOrgan): Promise<void> {
    const seq = ++openSeq;
    abort?.abort();
    abort = new AbortController();
    const signal = abort.signal;
    teardownDetail();
    for (const fn of overviewCleanup.splice(0)) fn();
    overview.innerHTML = '';
    current = organ;
    view.dataset.organ = organ;
    overview.hidden = true;
    detail.hidden = false;
    back.hidden = false;
    title.textContent = `${organLabel(registry, organ)} · parts, UMAP and trajectory`;
    summary.textContent = '';

    const figure = panel(`${organLabel(registry, organ)} · parts`);
    figure.el.classList.add('ov-figure');
    const umapPanel = panel('UMAP');
    const trajPanel = panel('Trajectory');
    detail.append(buildRail(organ), figure.el, umapPanel.el, trajPanel.el);
    for (const p of [figure, umapPanel, trajPanel]) p.body.innerHTML = `<p class="muted pc-loading">Loading…</p>`;

    const ids = organDatasetIds(organ);
    opts.setStatus(`loading ${organ}…`);
    try {
      const [graph, umapStore, trajStore, manifest] = await Promise.all([
        fetchGraph(api, ids.trajectory, signal),
        loadDataset(api, ids.umap, { signal }),
        loadDataset(api, ids.trajectory, { signal }),
        fetchManifest(api, ids.umap, signal)
      ]);
      if (seq !== openSeq || destroyed) return;
      if (umapStore.n !== trajStore.n) throw new Error('the UMAP and trajectory datasets have different cell counts');
      setBadge(manifest.meta?.synthetic === true);

      umapPanel.body.innerHTML = '';
      trajPanel.body.innerHTML = '';
      const umapHost = document.createElement('div');
      umapHost.className = 'pc-map floating-tools';
      umapPanel.body.appendChild(umapHost);
      const trajHost = document.createElement('div');
      trajHost.className = 'pc-map floating-tools';
      trajPanel.body.appendChild(trajHost);

      const uView = new ScatterView(umapHost, umapStore, { view: 'embedding', themes, registry });
      const tView = new TrajectoryView(trajHost, trajStore, { graph, themes, registry });
      uView.onDataGrew();
      tView.onDataGrew();
      umap = uView;
      trajectory = tView;
      detailCleanup.push(() => {
        uView.destroy();
        tView.destroy();
      });
      detailCleanup.push(observeResize(umapHost, () => uView.canvas.render()));
      detailCleanup.push(observeResize(trajHost, () => tView.canvas.render()));
      umapPanel.extra.textContent = `${umapStore.n.toLocaleString()} cells`;
      trajPanel.extra.textContent = `${trajStore.n.toLocaleString()} cells`;

      // The same cells in both plots: a selection in one is the selection in the other.
      detailCleanup.push(linkSelections(portOf(uView), portOf(tView)));

      figure.body.innerHTML = '';
      const ctx: AnatomyContext = {
        store: umapStore,
        registry,
        visible: () => null,
        selection: () => uView.selectionStore.current,
        rawSelection: () => uView.rawSelectionIndices(),
        select: indices => uView.selectIndices(indices),
        theme: () => themes.current
      };
      const panelHandle = createAnatomyPanel(figure.body, ctx, {
        compact: true,
        initial: { trail: [organ], override: [] }
      });
      anatomy = panelHandle;
      detailCleanup.push(() => panelHandle.destroy());
      detailCleanup.push(uView.selectionStore.subscribe(() => panelHandle.refresh()));
      detailCleanup.push(themes.subscribe(() => panelHandle.restyle()));

      const say = (): void => {
        const sel = uView.selectionStore.current;
        summary.textContent = sel
          ? `${sel.indices.length.toLocaleString()} of ${umapStore.n.toLocaleString()} cells selected, in the UMAP and the trajectory`
          : 'No cells selected. Click a part of the organ, or use Box or Lasso on either plot.';
      };
      detailCleanup.push(uView.selectionStore.subscribe(say));
      say();
      opts.setStatus(
        `${organLabel(registry, organ)} · ${umapStore.n.toLocaleString()} cells${manifest.meta?.synthetic ? ' · synthetic demo data' : ''}`
      );
    } catch (err) {
      if (signal.aborted || seq !== openSeq || destroyed) return;
      opts.setStatus('');
      for (const p of [figure, umapPanel, trajPanel]) {
        p.body.innerHTML = `<p class="pc-problem" role="alert">Could not load ${esc(organ)}: ${esc(
          err instanceof Error ? err.message : String(err)
        )}</p>`;
      }
    }
  }

  function showOverview(): void {
    openSeq++;
    abort?.abort();
    teardownDetail();
    current = null;
    view.dataset.organ = '';
    detail.hidden = true;
    overview.hidden = false;
    back.hidden = true;
    title.textContent = 'Organ view';
    summary.textContent = '';
    buildOverview();
    opts.setStatus(`Organ view · ${[...ORGAN_VIEW_ORGANS].filter(hasData).length} organs · synthetic demo data`);
  }

  async function select(organ: string | null): Promise<void> {
    if (organ === null) return showOverview();
    if (!isOrgan(organ) || !hasData(organ)) return;
    await openOrgan(organ);
  }

  back.addEventListener('click', () => void select(null));
  showOverview();
  return handle();

  function handle(): OrganViewHandle {
    return {
      selected: () => current,
      select,
      get umap() {
        return umap;
      },
      get trajectory() {
        return trajectory;
      },
      get anatomy() {
        return anatomy;
      },
      destroy() {
        destroyed = true;
        openSeq++;
        abort?.abort();
        for (const fn of overviewCleanup.splice(0)) fn();
        teardownDetail();
        root.innerHTML = '';
      }
    };
  }
}
