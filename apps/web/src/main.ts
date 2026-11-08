import './style.css';
import { fetchGraph, loadDataset } from '@core/data/loader';
import type { CellStore } from '@core/data/schema';
import type { PrincipalGraph } from '@core/data/manifest';
import { ScatterView } from './views/ScatterView';
import { TrajectoryView } from './views/TrajectoryView';
import { ChatPanel } from './chat/ChatPanel';
import { MockAdapter } from './chat/adapter';
import { ClaudeAdapter } from './chat/claude';
import { createViewSwitcher, type DatasetChoice } from './ui/ViewSwitcher';
import { createModeSwitcher } from './ui/ModeSwitcher';
import { createProtocolCreator, type ProtocolCreatorHandle } from './protocol/ProtocolCreator';
import { createOrganView, type OrganViewHandle } from './organ/OrganView';
import { isOrganDataset } from '@core/organ/organs';
import { createThemePicker } from './ui/ThemePicker';
import { ThemeStore } from './theme';
import { createDefaultRegistry } from '@core/anatomy/models';

import { API, START_SERVER_HINT } from './api';
import { esc } from './ui/escape';

/** Cell count implied by a dataset id such as `sim2m`, `traj500k` or `sim1500`. */
function sizeOf(id: string): number {
  const m = /(\d+)([km]?)$/.exec(id);
  return m ? Number(m[1]) * (m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1000 : 1) : 0;
}

/** Labels the datasets the tile server actually has, largest embedding first. */
function describe(ids: string[], hasGraph: (id: string) => boolean): DatasetChoice[] {
  const pretty = (id: string): string => {
    const m = /^(sim|traj|atlas)(\d+)([km]?)$/.exec(id);
    if (!m) return id;
    const size = m[3] === 'm' ? `${m[2]}M` : m[3] === 'k' ? `${m[2]}k` : Number(m[2]).toLocaleString();
    const kind = m[1] === 'traj' ? 'Trajectory' : m[1] === 'atlas' ? 'Atlas' : 'UMAP';
    return `${kind} · ${size} cells`;
  };
  const embeddings = ids.filter(id => !hasGraph(id)).sort((a, b) => sizeOf(b) - sizeOf(a));
  const trajectories = ids.filter(hasGraph).sort((a, b) => sizeOf(b) - sizeOf(a));
  // Embeddings first, largest first, so the switcher reads as a scale ladder.
  return [...embeddings, ...trajectories].map(id => ({
    id,
    label: pretty(id),
    kind: hasGraph(id) ? ('trajectory' as const) : ('embedding' as const)
  }));
}

/** The data server did not answer: not started yet, stopped, or unreachable. */
class ServerUnreachable extends Error {}

async function discoverDatasets(): Promise<DatasetChoice[]> {
  let res: Response;
  try {
    res = await fetch(`${API}/api/datasets`);
  } catch (err) {
    throw new ServerUnreachable(err instanceof Error ? err.message : String(err));
  }
  // Through the dev proxy a stopped server shows up as a 5xx, not a network error.
  if (!res.ok) throw new ServerUnreachable(res.status >= 500 ? `no answer, HTTP ${res.status}` : `HTTP ${res.status}`);
  // The Organ View's simulated datasets are reached through that view, not the switcher.
  const ids: string[] = ((await res.json()).datasets as string[]).filter(id => !isOrganDataset(id));
  const manifests = await Promise.all(
    ids.map(async id => {
      const m = await fetch(`${API}/api/dataset/${id}/manifest`);
      return { id, hasGraph: m.ok ? ((await m.json()).hasGraph as boolean) : false };
    })
  );
  const graphIds = new Set(manifests.filter(m => m.hasGraph).map(m => m.id));
  return describe(ids, id => graphIds.has(id));
}

/**
 * Finds the datasets, waiting for the data server if it is not up yet.
 *
 * "Failed to fetch" on a blank page tells a user nothing. Instead the page
 * says which server it is waiting for and the exact command that starts it,
 * and keeps retrying, so starting the server is all it takes.
 */
async function waitForDatasets(stage: HTMLElement, status: HTMLElement): Promise<DatasetChoice[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const found = await discoverDatasets();
      stage.innerHTML = '';
      return found;
    } catch (err) {
      if (!(err instanceof ServerUnreachable)) throw err;
      const where = `${API || location.origin}/api`;
      stage.innerHTML =
        `<div class="startup-problem" role="alert"><h2>Waiting for the data server</h2>` +
        `<p>The viewer cannot reach <code>${esc(where)}</code> (${esc(err.message)}). ` +
        `Start it from the project folder in a second terminal:</p>` +
        `<pre>${esc(START_SERVER_HINT)}</pre>` +
        `<p class="muted">This page retries on its own and opens as soon as the server answers.</p></div>`;
      status.textContent = 'waiting for the data server…';
      await new Promise(r => setTimeout(r, Math.min(5000, 1000 + attempt * 500)));
    }
  }
}

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  app.innerHTML = `<div class="top"></div><div class="stage"></div><div id="status"></div>`;
  const top = app.querySelector<HTMLElement>('.top')!;
  const stage = app.querySelector<HTMLElement>('.stage')!;
  const status = document.getElementById('status')!;
  // The theme applies before anything is drawn, so the first frame already
  // has the chosen background rather than flashing the default.
  const themes = new ThemeStore();
  const registry = createDefaultRegistry((model, err) =>
    console.error(`organ model "${model.id}" skipped: ${err.message}`)
  );

  let current: ScatterView | null = null;
  let chat: ChatPanel | null = null;
  let abort: AbortController | null = null;
  let protocol: ProtocolCreatorHandle | null = null;
  let organView: OrganViewHandle | null = null;
  /** The dataset to come back to when leaving the protocol creator. */
  let lastOpened: { id: string; kind: 'embedding' | 'trajectory' } | null = null;
  /** Shown before the final status, e.g. that an unknown ?dataset= was replaced. */
  let notice = '';

  async function open(id: string, kind: 'embedding' | 'trajectory'): Promise<void> {
    lastOpened = { id, kind };
    abort?.abort();
    abort = new AbortController();
    // Drop the test handle first, so a failed load cannot keep a destroyed
    // view (and its typed arrays) reachable.
    (window as unknown as { __cellViewer?: unknown }).__cellViewer = undefined;
    const signal = abort.signal;
    current?.destroy();
    chat?.destroy();
    current = null;
    stage.innerHTML = '';
    status.textContent = `${notice}loading ${id}…`;

    const chatRoot = document.createElement('div');
    chat = new ChatPanel(chatRoot, adapter);

    // The view is built as soon as the first chunk lands and fills in as the
    // rest arrive: the store is preallocated at full size, the prefix grows
    // monotonically, and every consumer reads only `[0, loadedCount)`.
    const build = (store: CellStore, graph: PrincipalGraph | null): ScatterView => {
      const view = graph
        ? new TrajectoryView(stage, store, { graph, chat: chat!, themes, registry })
        : new ScatterView(stage, store, { view: 'embedding', chat: chat!, themes, registry });
      current = view;
      // A handle for end-to-end tests and the visual check; nothing in the app
      // reads it.
      (window as unknown as { __cellViewer?: unknown }).__cellViewer = { view };
      stage.querySelector('.side')!.appendChild(chatRoot);
      return view;
    };

    try {
      const graph = kind === 'trajectory' ? await fetchGraph(API, id, signal) : null;
      const store = await loadDataset(API, id, {
        signal,
        onChunk: (_c, s) => {
          if (signal.aborted) return;
          // Report chunks as well as cells: cells only counts the contiguous
          // prefix, so a chunk that arrives out of order moves the chunk
          // number without moving the cell count, and a bare cell count would
          // look stalled.
          status.textContent =
            `${notice}${s.loadedChunks}/${s.chunks} chunks · ` +
            `${s.loadedCount.toLocaleString()} of ${s.n.toLocaleString()} cells ready`;
          if (!current && s.loadedCount > 0) build(s, graph);
          current?.onDataGrew();
        }
      });
      if (signal.aborted) return;

      const view = current ?? build(store, graph);
      view.onDataGrew();
      status.textContent =
        notice +
        (store.isComplete()
          ? `${store.loadedCount.toLocaleString()} cells`
          : `${store.loadedCount.toLocaleString()} of ${store.n.toLocaleString()} cells · ` +
            `${store.failedChunks.length} chunk(s) failed to load`);
      notice = '';
    } catch (err) {
      if (signal.aborted) return;
      status.textContent = `failed to load ${id}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  const datasets = await waitForDatasets(stage, status);
  // Asked only once the server is known to be up, so a server started late
  // still gets its real chat model rather than the offline fallback.
  const adapter = (await ClaudeAdapter.isConfigured(API)) ? new ClaudeAdapter(API) : new MockAdapter();
  if (datasets.length === 0) {
    status.textContent =
      'No datasets found. Run: python -m server.prep --sizes 100000 1000000 --traj-size 500000';
    return;
  }
  let modeSeq = 0;
  type Mode = 'datasets' | 'organ' | 'protocol';
  /**
   * Switches between the dataset viewer, the Organ View and the protocol
   * creator, tearing one down before building the next. Each mode owns its
   * own WebGL canvases, so leaving a mode destroys them rather than leaving
   * them drawing behind the page.
   */
  async function setMode(mode: Mode): Promise<void> {
    const seq = ++modeSeq;
    const datasetSwitcher = top.querySelector<HTMLElement>('.switcher');
    protocol?.destroy();
    protocol = null;
    (window as unknown as { __protocolCreator?: unknown }).__protocolCreator = undefined;
    organView?.destroy();
    organView = null;
    (window as unknown as { __organView?: unknown }).__organView = undefined;
    if (mode === 'datasets') {
      if (datasetSwitcher) datasetSwitcher.hidden = false;
      if (lastOpened) await open(lastOpened.id, lastOpened.kind);
      return;
    }
    abort?.abort();
    (window as unknown as { __cellViewer?: unknown }).__cellViewer = undefined;
    current?.destroy();
    chat?.destroy();
    current = null;
    chat = null;
    stage.innerHTML = '';
    if (datasetSwitcher) datasetSwitcher.hidden = true;
    if (mode === 'organ') {
      const created = await createOrganView(stage, {
        api: API,
        themes,
        registry,
        setStatus: text => {
          if (seq === modeSeq) status.textContent = text;
        }
      });
      if (seq !== modeSeq) {
        created.destroy();
        return;
      }
      organView = created;
      (window as unknown as { __organView?: unknown }).__organView = created;
      return;
    }
    // Trajectories only, largest first; one above a million cells would make
    // the creator slow to open for what is a guided view of the graph.
    const trajectories = datasets.filter(d => d.kind === 'trajectory');
    const pick = trajectories.find(d => sizeOf(d.id) <= 1_000_000) ?? trajectories[trajectories.length - 1];
    if (!pick) {
      status.textContent = 'The protocol creator needs a trajectory dataset, and none was found.';
      return;
    }
    const created = await createProtocolCreator(stage, {
      api: API,
      datasetId: pick.id,
      themes,
      registry,
      setStatus: text => {
        if (seq === modeSeq) status.textContent = text;
      }
    });
    if (seq !== modeSeq) {
      created.destroy();
      return;
    }
    protocol = created;
    (window as unknown as { __protocolCreator?: unknown }).__protocolCreator = created;
  }

  const modes = createModeSwitcher(
    top,
    [
      { id: 'datasets' as const, label: 'Datasets' },
      {
        id: 'organ' as const,
        label: 'Organ view',
        title: 'Pick an organ on the body, then a part of it, to see its UMAP and trajectory (synthetic demo data)'
      },
      {
        id: 'protocol' as const,
        label: 'Protocol creator',
        title: 'Trace a differentiation path back to the stem cell (synthetic demo data)'
      }
    ],
    'datasets',
    mode => void setMode(mode)
  );
  createViewSwitcher(top, datasets, (id, kind) => void open(id, kind));
  createThemePicker(top, themes);

  // Opening the very largest dataset by default would punish anyone arriving on
  // a modest machine, and once the benchmark datasets exist the largest is 10M.
  // Open the biggest embedding that still loads comfortably everywhere, and let
  // the switcher (or ?dataset=) reach the rest.
  const requested = new URLSearchParams(location.search).get('dataset');
  const asked = requested ? datasets.find(d => d.id === requested) : undefined;
  if (requested && !asked) {
    // Silently opening something else would look like the parameter worked,
    // so the notice stays on the status line through the load.
    notice = `No dataset named "${requested}" (available: ${datasets.map(d => d.id).join(', ')}). `;
  }
  const first =
    asked ??
    datasets.find(d => d.kind === 'embedding' && sizeOf(d.id) <= 1_000_000) ??
    datasets[0];
  const startIndex = datasets.indexOf(first);
  top
    .querySelectorAll('.switcher button')
    .forEach((b, i) => b.classList.toggle('active', i === startIndex));
  lastOpened = { id: first.id, kind: first.kind };
  // ?mode=protocol or ?mode=organ opens that mode directly, without loading a
  // dataset first; ?organ=heart then opens an organ.
  const startMode = new URLSearchParams(location.search).get('mode');
  if (startMode === 'protocol') {
    modes.setMode('protocol');
    await setMode('protocol');
    return;
  }
  if (startMode === 'organ') {
    modes.setMode('organ');
    await setMode('organ');
    const organ = new URLSearchParams(location.search).get('organ');
    // Read through a function: TypeScript cannot see that setMode assigned it.
    const opened = (): OrganViewHandle | null => organView;
    if (organ) await opened()?.select(organ);
    return;
  }
  await open(first.id, first.kind);
}

main().catch(err => {
  const app = document.getElementById('app')!;
  app.innerHTML =
    `<div class="startup-problem" role="alert"><h2>The viewer could not start</h2>` +
    `<p>${esc(err instanceof Error ? err.message : String(err))}</p>` +
    `<p class="muted">Reload the page to try again. If it keeps happening, check the browser console ` +
    `and that the data server is running (<code>${esc(START_SERVER_HINT)}</code>).</p></div>`;
});
