import '../style.css';
import { loadDataset } from '@core/data/loader';
import { buildGrid } from '@core/index/grid';
import { selectPolygon } from '@core/select/query';
import {
  FrameSampler,
  formatMarkdown,
  MIN_FRAMES_FOR_PERCENTILE,
  type BenchRow
} from '@core/bench/metrics';
import { ScatterCanvas } from '../views/ScatterCanvas';

const API = (import.meta.env.VITE_API as string | undefined) ?? 'http://localhost:8000';

/** Ordered smallest first, so a run that hits the wall still reports the rest. */
const ORDER = ['sim100k', 'sim500k', 'sim1m', 'sim2m', 'sim5m', 'sim10m'];

function heapMb(): number {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? mem.usedJSHeapSize / 1024 / 1024 : NaN;
}

/**
 * Measures the frame rate deck.gl actually achieves while the view moves.
 *
 * Frames are counted from deck.gl's own `onAfterRender`, not from
 * `requestAnimationFrame`. An rAF loop keeps ticking whether or not the
 * renderer produced anything, so it reports the callback rate rather than the
 * frame rate — which is how an earlier version of this harness produced 12 fps
 * at one million points on a machine that was drawing nothing at all.
 *
 * The motion is a deck.gl view-state transition, so the renderer drives itself
 * at whatever rate it can sustain instead of being poked once per callback.
 */
async function measurePan(
  canvas: ScatterCanvas,
  ms: number,
  frames: { deltas: number[]; last: number }
): Promise<{ fps: number; p5: number | null; frames: number }> {
  const sampler = new FrameSampler();
  const [x0, y0, x1, y1] = canvas.storeBounds();
  frames.deltas.length = 0;
  frames.last = performance.now();

  // Sweep the viewport so dense regions really do enter and leave it;
  // measuring a still frame measures nothing.
  canvas.panTo([(x0 + x1) / 2 + (x1 - x0) * 0.25, (y0 + y1) / 2 + (y1 - y0) * 0.25], ms / 2);
  await new Promise(r => setTimeout(r, ms / 2));
  canvas.panTo([(x0 + x1) / 2 - (x1 - x0) * 0.25, (y0 + y1) / 2 - (y1 - y0) * 0.25], ms / 2);
  await new Promise(r => setTimeout(r, ms / 2));

  for (const d of frames.deltas) sampler.pushDelta(d);
  const s = sampler.summary();
  return {
    fps: Math.round((s.frames / (ms / 1000)) * 10) / 10,
    p5: s.frames >= MIN_FRAMES_FOR_PERCENTILE ? s.p5 : null,
    frames: s.frames
  };
}

async function runOne(
  id: string,
  holder: HTMLElement,
  log: (s: string) => void
): Promise<BenchRow> {
  log(`loading ${id}…`);
  const t0 = performance.now();
  let firstChunkAt = 0;
  const store = await loadDataset(API, id, {
    onChunk: () => {
      if (!firstChunkAt) firstChunkAt = performance.now();
    }
  });
  const loadMs = performance.now() - t0;

  holder.innerHTML = '';
  const frames = { deltas: [] as number[], last: performance.now() };
  const tFrame = performance.now();
  // Full detail: the point of the sweep is to find the wall, not to dodge it.
  const canvas = new ScatterCanvas(holder, store, {
    budget: Number.POSITIVE_INFINITY,
    onAfterRender: () => {
      const now = performance.now();
      frames.deltas.push(now - frames.last);
      frames.last = now;
    }
  });
  await new Promise(r => requestAnimationFrame(() => r(null)));
  const firstFrameMs = performance.now() - tFrame;

  const tGrid = performance.now();
  const grid = buildGrid(store.xy, store.loadedCount);
  const gridMs = performance.now() - tGrid;

  const [x0, y0, x1, y1] = store.bounds;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const r = Math.min(x1 - x0, y1 - y0) * 0.18;
  const poly = new Float64Array(120);
  for (let k = 0; k < 60; k++) {
    const a = (k / 60) * Math.PI * 2;
    poly[k * 2] = cx + Math.cos(a) * r;
    poly[k * 2 + 1] = cy + Math.sin(a) * r;
  }
  const lassoTimes: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    selectPolygon(store.xy, store.loadedCount, poly, grid);
    lassoTimes.push(performance.now() - t);
  }
  lassoTimes.sort((a, b) => a - b);

  log(`panning ${id}…`);
  const rebuildsBefore = canvas.layerRebuilds();
  const fps = await measurePan(canvas, 3000, frames);
  const m = canvas.metrics();
  console.log(
    `[diag] ${id}: layer rebuilds during pan=${canvas.layerRebuilds() - rebuildsBefore} ` +
      `gpuTime=${m.gpuTime?.toFixed?.(2)} cpuTime=${m.cpuTime?.toFixed?.(2)} ` +
      `setPropsTime=${m.setPropsTime?.toFixed?.(2)} ` +
      `updateAttributesTime=${m.updateAttributesTime?.toFixed?.(2)} ` +
      `framesRedrawn=${m.framesRedrawn} sampledFrames=${fps.frames}`
  );
  const row: BenchRow = {
    n: store.loadedCount,
    loadMs,
    decodeMs: firstChunkAt ? firstChunkAt - t0 : 0,
    gridMs,
    firstFrameMs,
    fps: fps.fps,
    frames: fps.frames,
    fpsP5: fps.p5,
    lassoMs: lassoTimes[5],
    heapMb: heapMb()
  };
  canvas.destroy();
  return row;
}

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  app.innerHTML = `<div class="bench">
    <h1>Capacity sweep</h1>
    <p class="muted">Measures how far this browser and this machine actually go.
      Each size is loaded, rendered at full detail with no level-of-detail
      subsampling, panned for three seconds, and lassoed ten times. Point radius
      is fixed, so the fill-rate cost is comparable across sizes.</p>
    <p><button id="run">Run sweep</button>
       <button id="radius">Radius comparison at the largest size</button></p>
    <div id="log" class="muted"></div>
    <pre id="out">(no results yet)</pre>
    <div id="stage" style="height:420px;position:relative;border:1px solid #232838;border-radius:6px"></div>
  </div>`;

  const out = document.getElementById('out')!;
  const logEl = document.getElementById('log')!;
  const stage = document.getElementById('stage')!;
  const log = (s: string): void => {
    logEl.textContent = s;
  };

  const available: string[] = (await (await fetch(`${API}/api/datasets`)).json()).datasets;
  const present = ORDER.filter(id => available.includes(id));
  log(`datasets available: ${present.join(', ') || 'none'}`);

  document.getElementById('run')!.addEventListener('click', async () => {
    const rows: BenchRow[] = [];
    for (const id of present) {
      try {
        rows.push(await runOne(id, stage, log));
      } catch (err) {
        // A size that exhausts memory is a result, not a crash: record where
        // the wall is and keep the rows already measured.
        const msg = err instanceof Error ? err.message : String(err);
        log(`${id} failed: ${msg}`);
        out.textContent = `${formatMarkdown(rows)}\n\nStopped at ${id}: ${msg}`;
        return;
      }
      out.textContent = formatMarkdown(rows);
    }
    log('done');
  });

  // Separates "too many points" from "too much overdraw": same point count,
  // different radius. If the small radius is much faster, the limit is fill rate.
  document.getElementById('radius')!.addEventListener('click', async () => {
    const id = present[present.length - 1];
    if (!id) return;
    log(`radius comparison on ${id}…`);
    const store = await loadDataset(API, id);
    const results: string[] = [];
    for (const radius of [0.5, 2.5]) {
      stage.innerHTML = '';
      const frames = { deltas: [] as number[], last: performance.now() };
      const canvas = new ScatterCanvas(stage, store, {
        budget: Number.POSITIVE_INFINITY,
        onAfterRender: () => {
          const now = performance.now();
          frames.deltas.push(now - frames.last);
          frames.last = now;
        }
      });
      canvas.setLod(1);
      canvas.setPointRadiusOverride(radius);
      await new Promise(r => requestAnimationFrame(() => r(null)));
      const fps = await measurePan(canvas, 3000, frames);
      results.push(
        `radius ${radius.toFixed(1)}px: ${fps.fps} fps (${fps.frames} frames in 3 s)`
      );
      canvas.destroy();
    }
    out.textContent =
      `${out.textContent}\n\nFill-rate check on ${id} (${store.loadedCount.toLocaleString()} points):\n` +
      results.join('\n');
    log('done');
  });
}

void main();
