import './style.css';
import { fetchGraph, loadDataset } from '@core/data/loader';
import { ScatterView } from './views/ScatterView';
import { TrajectoryView } from './views/TrajectoryView';
import { ChatPanel } from './chat/ChatPanel';
import { MockAdapter } from './chat/adapter';
import { ClaudeAdapter } from './chat/claude';
import { createViewSwitcher, type DatasetChoice } from './ui/ViewSwitcher';

const API = (import.meta.env.VITE_API as string | undefined) ?? 'http://localhost:8000';

/** Cell count implied by a dataset id such as `sim2m` or `traj500k`. */
function sizeOf(id: string): number {
  const m = /(\d+)([km])$/.exec(id);
  return m ? Number(m[1]) * (m[2] === 'm' ? 1_000_000 : 1000) : 0;
}

/** Labels the datasets the tile server actually has, largest embedding first. */
function describe(ids: string[], hasGraph: (id: string) => boolean): DatasetChoice[] {
  const pretty = (id: string): string => {
    const m = /^(sim|traj)(\d+)([km])$/.exec(id);
    if (!m) return id;
    const size = `${m[2]}${m[3] === 'm' ? 'M' : 'k'}`;
    return `${m[1] === 'traj' ? 'Trajectory' : 'UMAP'} · ${size} cells`;
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

async function discoverDatasets(): Promise<DatasetChoice[]> {
  const res = await fetch(`${API}/api/datasets`);
  if (!res.ok) throw new Error(`cannot reach the tile server at ${API}`);
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

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  app.innerHTML = `<div class="top"></div><div class="stage"></div><div id="status"></div>`;
  const top = app.querySelector<HTMLElement>('.top')!;
  const stage = app.querySelector<HTMLElement>('.stage')!;
  const status = document.getElementById('status')!;

  const adapter = (await ClaudeAdapter.isConfigured(API))
    ? new ClaudeAdapter(API)
    : new MockAdapter();

  let current: ScatterView | null = null;
  let chat: ChatPanel | null = null;
  let abort: AbortController | null = null;

  async function open(id: string, kind: 'embedding' | 'trajectory'): Promise<void> {
    abort?.abort();
    abort = new AbortController();
    const signal = abort.signal;
    current?.destroy();
    chat?.destroy();
    current = null;
    stage.innerHTML = '';
    status.textContent = `loading ${id}…`;

    const chatRoot = document.createElement('div');
    chat = new ChatPanel(chatRoot, adapter);

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
            `${s.loadedChunks}/${s.chunks} chunks · ` +
            `${s.loadedCount.toLocaleString()} of ${s.n.toLocaleString()} cells ready`;
          current?.onDataGrew();
        }
      });
      if (signal.aborted) return;

      const view = graph
        ? new TrajectoryView(stage, store, { graph, chat })
        : new ScatterView(stage, store, { view: 'embedding', chat });
      current = view;
      stage.querySelector('.side')!.appendChild(chatRoot);
      view.onDataGrew();
      status.textContent = store.isComplete()
        ? `${store.loadedCount.toLocaleString()} cells`
        : `${store.loadedCount.toLocaleString()} of ${store.n.toLocaleString()} cells · ` +
          `${store.failedChunks.length} chunk(s) failed to load`;
    } catch (err) {
      if (signal.aborted) return;
      status.textContent = `failed to load ${id}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  const datasets = await discoverDatasets();
  if (datasets.length === 0) {
    status.textContent =
      'No datasets found. Run: python -m server.prep --sizes 100000 1000000 --traj-size 500000';
    return;
  }
  createViewSwitcher(top, datasets, (id, kind) => void open(id, kind));

  // Opening the very largest dataset by default would punish anyone arriving on
  // a modest machine, and once the benchmark datasets exist the largest is 10M.
  // Open the biggest embedding that still loads comfortably everywhere, and let
  // the switcher (or ?dataset=) reach the rest.
  const requested = new URLSearchParams(location.search).get('dataset');
  const asked = requested ? datasets.find(d => d.id === requested) : undefined;
  if (requested && !asked) {
    // Silently opening something else would look like the parameter worked.
    status.textContent =
      `No dataset named "${requested}". Available: ${datasets.map(d => d.id).join(', ')}`;
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
  document.getElementById('app')!.textContent = `failed to start: ${err.message}`;
});
