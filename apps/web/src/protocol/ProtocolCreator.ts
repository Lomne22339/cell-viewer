import { fetchGraph, loadDataset } from '@core/data/loader';
import type { PrincipalGraph } from '@core/data/manifest';
import type { CellStore } from '@core/data/schema';
import type { OrganRegistry } from '@core/anatomy/registry';
import type { ChatAdapter } from '@core/chat/adapter';
import { nearestNodeCounts } from '@core/protocol/cells';
import { RecipeMockAdapter, withRecipeContext, type RecipeContext } from '@core/protocol/recipe';
import { ProtocolState, type ProtocolSnapshot } from '@core/protocol/state';
import { synthesizeProtocol } from '@core/protocol/synthetic';
import { milestoneWeights, nodeMilestones } from '@core/protocol/trace';
import type { ProtocolTree } from '@core/protocol/types';
import { ChatPanel } from '../chat/ChatPanel';
import { ServiceAdapter } from '../chat/service';
import { TrajectoryView } from '../views/TrajectoryView';
import type { GraphTrace } from '../views/traceLayers';
import { createPanelGrid, type PanelGridHandle } from '../ui/PanelGrid';
import { esc } from '../ui/escape';
import type { ThemeStore } from '../theme';
import { createTreePanel, type TreePanelHandle } from './TreePanel';

export interface ProtocolCreatorOptions {
  api: string;
  /** A trajectory dataset; the creator does not choose one itself. */
  datasetId: string;
  themes: ThemeStore;
  registry: OrganRegistry;
  setStatus: (text: string) => void;
}

export interface ProtocolCreatorHandle {
  readonly view: TrajectoryView | null;
  readonly state: ProtocolState | null;
  readonly tree: ProtocolTree | null;
  readonly grid: PanelGridHandle;
  destroy: () => void;
}

/** Cells looked at when ranking lineages by crowding; an even sample of the loaded cells. */
const WEIGHT_SAMPLES = 20_000;

/**
 * The differentiation protocol creator: a trajectory map, a pathway graph and
 * a recipe chat over one shared `ProtocolState`.
 *
 * Only the map is a WebGL canvas, and it is the existing `TrajectoryView`
 * unchanged but for a compact mode, a node-click callback and a trace overlay.
 * Choosing a milestone anywhere, or a timepoint in the bar, goes through the
 * state; each panel redraws from the snapshot it is handed, and none keeps a
 * copy. The tree is derived from the trajectory graph and is synthetic demo
 * data, which every panel says.
 */
export async function createProtocolCreator(root: HTMLElement, opts: ProtocolCreatorOptions): Promise<ProtocolCreatorHandle> {
  const abort = new AbortController();
  root.innerHTML =
    `<div class="pc"><div class="pc-bar"></div><div class="pc-grid"></div></div>`;
  const bar = root.querySelector<HTMLElement>('.pc-bar')!;
  const gridHost = root.querySelector<HTMLElement>('.pc-grid')!;

  let view: TrajectoryView | null = null;
  let mapEl: HTMLElement | null = null;
  /** Set by an expand or collapse; the next resize of the map refits the graph. */
  let refit = false;
  let state: ProtocolState | null = null;
  let tree: ProtocolTree | null = null;
  let tp: TreePanelHandle | null = null;
  let chat: ChatPanel | null = null;
  let unsubscribe: (() => void) | null = null;
  let destroyed = false;

  const grid = createPanelGrid(
    gridHost,
    [
      { id: 'map', title: 'Trajectory map' },
      { id: 'graph', title: 'Differentiation pathway' },
      { id: 'recipe', title: 'Recipe maker' }
    ],
    {
      // A canvas does not notice its container changing size, so the map is
      // asked to redraw whenever its panel's body does.
      onResize: id => {
        if (id !== 'map' || !view) return;
        // After an expand or collapse the old zoom no longer frames the graph
        // in the new shape, so the whole graph is fitted once, at the new size.
        // Fitting draws a frame itself; drawing another first would double the
        // cost of the slowest thing on the page.
        if (refit) {
          refit = false;
          view.canvas.fitBounds(view.canvas.storeBounds(), 0);
        } else {
          view.canvas.render();
        }
      },
      // Box and lasso live in the map's toolbar, which only the expanded map
      // shows, floating over the plot.
      onExpand: id => {
        refit = true;
        // Expanding can happen before the map exists, while the data loads.
        mapEl?.classList.toggle('floating-tools', id === 'map');
        view?.setCompact(id !== 'map');
      }
    }
  );
  for (const id of ['map', 'graph', 'recipe']) {
    grid.body(id).innerHTML = `<p class="muted pc-loading">Loading…</p>`;
  }

  const handle: ProtocolCreatorHandle = {
    get view() {
      return view;
    },
    get state() {
      return state;
    },
    get tree() {
      return tree;
    },
    grid,
    destroy() {
      destroyed = true;
      abort.abort();
      unsubscribe?.();
      tp?.destroy();
      chat?.destroy();
      view?.destroy();
      grid.destroy();
      root.innerHTML = '';
    }
  };

  const fail = (message: string): ProtocolCreatorHandle => {
    bar.innerHTML = `<span class="pc-problem" role="alert">${esc(message)}</span>`;
    return handle;
  };

  let graph: PrincipalGraph;
  let store: CellStore;
  try {
    opts.setStatus(`loading ${opts.datasetId}…`);
    graph = await fetchGraph(opts.api, opts.datasetId, abort.signal);
    store = await loadDataset(opts.api, opts.datasetId, {
      signal: abort.signal,
      onChunk: (_c, s) => {
        if (!destroyed) opts.setStatus(`${s.loadedChunks}/${s.chunks} chunks · ${s.loadedCount.toLocaleString()} cells ready`);
      }
    });
  } catch (err) {
    if (destroyed) return handle;
    opts.setStatus('');
    return fail(`Could not load ${opts.datasetId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (destroyed) return handle;

  const stageLabels = store.levels.get('stage') ?? ['start', 'end'];
  tree = synthesizeProtocol(graph, { datasetId: opts.datasetId, stageLabels });
  const nodeMap = nodeMilestones(tree, graph.nodes.length);
  const { counts } = nearestNodeCounts(graph, store.xy, store.loadedCount, WEIGHT_SAMPLES);
  state = new ProtocolState(tree, milestoneWeights(tree, nodeMap, counts));
  const t = tree;
  const s = state;
  const lastNode = (id: number): number => t.milestones[id].graphNodes[t.milestones[id].graphNodes.length - 1];

  // ---- timepoint bar -------------------------------------------------------
  bar.innerHTML =
    `<span class="pc-badge" title="The milestones, factors and markers are invented placeholders.">Synthetic demo data</span>` +
    `<span class="label">Timepoint</span>` +
    `<span class="pc-stages" role="group" aria-label="Timepoint">` +
    stageLabels
      .map((l, i) => `<button class="btn btn-small" data-stage="${i}" aria-pressed="false">${esc(l)}</button>`)
      .join('') +
    `</span>` +
    `<button class="btn btn-small" data-act="earlier" title="One step toward the stem cell">◀</button>` +
    `<button class="btn btn-small" data-act="later" title="One step toward the target">▶</button>` +
    `<button class="btn btn-small" data-act="clear">Clear</button>` +
    `<span class="pc-target" aria-live="polite"></span>`;
  const targetText = bar.querySelector<HTMLElement>('.pc-target')!;
  bar.addEventListener('click', ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!btn) return;
    if (btn.dataset.stage !== undefined) {
      const i = Number(btn.dataset.stage);
      s.setStage(s.snapshot().stage === i ? null : i);
    } else if (btn.dataset.act === 'earlier') s.step(-1);
    else if (btn.dataset.act === 'later') s.step(1);
    else if (btn.dataset.act === 'clear') {
      s.setStage(null);
      s.click(null);
    }
  });
  const renderBar = (snap: ProtocolSnapshot): void => {
    bar.querySelectorAll<HTMLButtonElement>('button[data-stage]').forEach(b => {
      const on = Number(b.dataset.stage) === snap.stage;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const earlier = bar.querySelector<HTMLButtonElement>('[data-act="earlier"]')!;
    const later = bar.querySelector<HTMLButtonElement>('[data-act="later"]')!;
    earlier.disabled = snap.focus === null || snap.focus === 0;
    later.disabled = snap.focus === null || snap.focus === snap.traced.length - 1;
    if (snap.target === null) {
      targetText.textContent = 'Click a milestone on the map or the graph, or choose a timepoint.';
    } else {
      const m = t.milestones[snap.target];
      const how =
        snap.stage !== null && snap.clicked === null
          ? ' (following the lineage with the most cells)'
          : snap.stage !== null
            ? ' (along the clicked lineage)'
            : '';
      targetText.textContent = `Tracing ${m.label} · day ${m.day} · stage ${stageLabels[m.stageIndex]}${how}`;
    }
  };

  // ---- panel A: the existing trajectory view -------------------------------
  const mapHost = document.createElement('div');
  mapHost.className = 'pc-map';
  mapEl = mapHost;
  // Expanded while loading: the map opens already expanded.
  mapHost.classList.toggle('floating-tools', grid.expanded() === 'map');
  grid.body('map').innerHTML = '';
  grid.body('map').appendChild(mapHost);
  /** Set while a click on the map is being passed to the state, so it is not echoed back. */
  let fromMap = false;
  view = new TrajectoryView(mapHost, store, {
    graph,
    themes: opts.themes,
    registry: opts.registry,
    compact: grid.expanded() !== 'map',
    onNodeSelect: node => {
      fromMap = true;
      try {
        if (node === null) s.click(null);
        else if (nodeMap[node] >= 0) s.click(nodeMap[node]);
      } finally {
        fromMap = false;
      }
    }
  });
  view.onDataGrew();

  // ---- panel B: the pathway graph ------------------------------------------
  grid.body('graph').innerHTML = '';
  tp = createTreePanel(grid.body('graph'), t, s);

  // ---- panel C: the recipe chat --------------------------------------------
  const recipeHost = document.createElement('div');
  recipeHost.className = 'pc-recipe';
  grid.body('recipe').innerHTML = '';
  grid.body('recipe').appendChild(recipeHost);
  const context = (): RecipeContext => ({ tree: t, chain: s.snapshot().traced });
  const service = await ServiceAdapter.isReady(opts.api);
  if (destroyed) return handle;
  const adapter: ChatAdapter = service ? withRecipeContext(new ServiceAdapter(opts.api), context) : new RecipeMockAdapter(context);
  chat = new ChatPanel(recipeHost, adapter, {
    title: 'Recipe maker (synthetic demo)',
    placeholder: 'Ask for a recipe to the chosen milestone…',
    requireSelection: false
  });
  grid.header('recipe').textContent = service ? 'chatbot service' : 'offline demo';

  // ---- one state, three views ----------------------------------------------
  let lastClicked: number | null = null;
  const apply = (snap: ProtocolSnapshot): void => {
    const trace: GraphTrace | null =
      snap.traced.length === 0
        ? null
        : {
            path: snap.traced.flatMap(id => t.milestones[id].graphNodes),
            marks: snap.traced.map(lastNode),
            focus: snap.focus
          };
    view?.setTrace(trace);
    tp?.update(snap);
    renderBar(snap);
    // A choice made on the graph also selects its node on the map. One made
    // on the map is already selected there.
    if (!fromMap && snap.clicked !== lastClicked) view?.selectNode(snap.clicked === null ? null : lastNode(snap.clicked));
    lastClicked = snap.clicked;
  };
  unsubscribe = s.subscribe(apply);
  apply(s.snapshot());
  opts.setStatus(`${opts.datasetId} · ${store.loadedCount.toLocaleString()} cells · synthetic demo data`);
  return handle;
}
