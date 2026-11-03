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
  return [...embeddings, ...trajectories].map(id => ({
    id,
    label: pretty(id),
    kind: hasGraph(id) ? ('trajectory' as const) : ('embedding' as const)
  }));
}

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
  const ids: string[] = (await res.json()).datasets;
  const manifests = await Promise.all(
    ids.map(async id => {
      const m = await fetch(`${API}/api/dataset/${id}/manifest`);
      return { id, hasGraph: m.ok ? ((await m.json()).hasGraph as boolean) : false };
    })
  );
  const graphIds = new Set(manifests.filter(m => m.hasGraph).map(m => m.id));
  return describe(ids, id => graphIds.has(id));
}

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
  const themes = new ThemeStore();
  const registry = createDefaultRegistry((model, err) =>
    console.error(`organ model "${model.id}" skipped: ${err.message}`)
  );

  let current: ScatterView | null = null;
  let chat: ChatPanel | null = null;
  let abort: AbortController | null = null;
  let notice = '';

  async function open(id: string, kind: 'embedding' | 'trajectory'): Promise<void> {
    abort?.abort();
    abort = new AbortController();
    const signal = abort.signal;
    current?.destroy();
    chat?.destroy();
    current = null;
    stage.innerHTML = '';
    status.textContent = `${notice}loading ${id}…`;

    const chatRoot = document.createElement('div');
    chat = new ChatPanel(chatRoot, adapter);

    // The view is built when the first chunk lands; consumers read only [0, loadedCount).
    const build = (store: CellStore, graph: PrincipalGraph | null): ScatterView => {
      const view = graph
        ? new TrajectoryView(stage, store, { graph, chat: chat!, themes, registry })
        : new ScatterView(stage, store, { view: 'embedding', chat: chat!, themes, registry });
      current = view;
      stage.querySelector('.side')!.appendChild(chatRoot);
      return view;
    };

    try {
      const graph = kind === 'trajectory' ? await fetchGraph(API, id, signal) : null;
      const store = await loadDataset(API, id, {
        signal,
        onChunk: (_c, s) => {
          if (signal.aborted) return;
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
  const adapter = (await ClaudeAdapter.isConfigured(API)) ? new ClaudeAdapter(API) : new MockAdapter();
  if (datasets.length === 0) {
    status.textContent =
      'No datasets found. Run: python -m server.prep --sizes 100000 1000000 --traj-size 500000';
    return;
  }
  createViewSwitcher(top, datasets, (id, kind) => void open(id, kind));
  createThemePicker(top, themes);

  // Open the biggest embedding that loads comfortably everywhere; ?dataset= reaches the rest.
  const requested = new URLSearchParams(location.search).get('dataset');
  const asked = requested ? datasets.find(d => d.id === requested) : undefined;
  if (requested && !asked) {
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
