import '../style.css';
import { Deck, LinearInterpolator, OrthographicView, type Layer } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { loadDataset } from '@core/data/loader';
import { recolorCategorical } from '@core/color/recolor';
import type { CellStore } from '@core/data/schema';

const API = (import.meta.env.VITE_API as string | undefined) ?? 'http://localhost:8000';
const DATASET = new URLSearchParams(location.search).get('dataset') ?? 'sim1m';
const WINDOW_MS = 3000;

/**
 * Isolates why the point cloud renders slower than deck.gl's published
 * figures suggest it should.
 *
 * Each variant builds deck.gl directly — not through `ScatterCanvas` — so the
 * comparison separates "our wrapper is doing something expensive" from "this
 * configuration is expensive". Frames are counted from `onAfterRender`, never
 * from `requestAnimationFrame`, and motion is a deck.gl transition so the
 * renderer paces itself.
 */
interface Variant {
  name: string;
  note: string;
  chunked: boolean;
  pickable: boolean;
  useDevicePixels: boolean;
  radius: number;
  blend: boolean;
}

const VARIANTS: Variant[] = [
  { name: 'baseline', note: 'one layer, no picking, device pixels on', chunked: false, pickable: false, useDevicePixels: true, radius: 1.2, blend: true },
  { name: 'chunked', note: 'one layer per 250k chunk (what the app ships)', chunked: true, pickable: false, useDevicePixels: true, radius: 1.2, blend: true },
  { name: 'pickable', note: 'chunked + pickable (what the app shipped)', chunked: true, pickable: true, useDevicePixels: true, radius: 1.2, blend: true },
  { name: 'css-pixels', note: 'chunked, useDevicePixels false (quarter the fragments on Retina)', chunked: true, pickable: false, useDevicePixels: false, radius: 1.2, blend: true },
  { name: 'no-blend', note: 'chunked, blending off', chunked: true, pickable: false, useDevicePixels: true, radius: 1.2, blend: false },
  { name: 'lean', note: 'no picking, css pixels, no blending', chunked: true, pickable: false, useDevicePixels: false, radius: 1.2, blend: false }
];

function layersFor(store: CellStore, v: Variant): Layer[] {
  const make = (id: string, start: number, count: number): Layer =>
    new ScatterplotLayer({
      id,
      data: {
        length: count,
        attributes: {
          getPosition: { value: store.xy.subarray(start * 2, (start + count) * 2), size: 2 },
          getFillColor: {
            value: store.color.subarray(start * 4, (start + count) * 4),
            size: 4,
            normalized: true
          }
        }
      },
      radiusUnits: 'pixels',
      getRadius: v.radius,
      radiusMinPixels: 0.4,
      radiusMaxPixels: 8,
      stroked: false,
      pickable: v.pickable,
      parameters: v.blend ? {} : { blend: false }
    });

  if (!v.chunked) return [make('all', 0, store.loadedCount)];
  const out: Layer[] = [];
  for (let c = 0; c * store.chunkSize < store.loadedCount; c++) {
    const start = c * store.chunkSize;
    const count = Math.min(store.chunkSize, store.loadedCount - start);
    if (count > 0) out.push(make(`chunk-${c}`, start, count));
  }
  return out;
}

async function runVariant(store: CellStore, v: Variant, host: HTMLElement): Promise<number> {
  host.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  host.appendChild(canvas);

  let frames = 0;
  const [x0, y0, x1, y1] = store.bounds;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const zoom = Math.log2(
    Math.min(host.clientWidth / Math.max(x1 - x0, 1e-6), host.clientHeight / Math.max(y1 - y0, 1e-6))
  );

  let viewState: Record<string, unknown> = {
    target: [cx, cy, 0],
    zoom: Number.isFinite(zoom) ? zoom : 0
  };
  const layers = layersFor(store, v);

  const deck: Deck<OrthographicView> = new Deck({
    canvas,
    views: new OrthographicView({ id: 'ortho' }),
    viewState: viewState as never,
    // deck.gl's transition manager is part of the controller, so a view-state
    // transition simply does not animate without one — which is how the first
    // run of this page reported an identical 0.7 fps for every variant.
    controller: true,
    useDevicePixels: v.useDevicePixels,
    parameters: { depthCompare: 'always' },
    // In controlled mode the transition manager publishes each interpolated
    // view state through onViewStateChange; if the handler does not feed it
    // back, the camera never actually moves and only the two endpoint frames
    // get drawn. That is what produced an identical 0.7 fps for every variant
    // on the first two runs of this page.
    onViewStateChange: ({ viewState: vs }: { viewState: unknown }) => {
      viewState = vs as Record<string, unknown>;
      deck.setProps({ viewState: viewState as never });
      return vs as never;
    },
    onAfterRender: () => {
      frames++;
    },
    layers
  });

  const pan = (tx: number, ty: number, ms: number): void => {
    viewState = {
      ...viewState,
      target: [tx, ty, 0],
      transitionDuration: ms,
      transitionInterpolator: new LinearInterpolator(['target'])
    };
    deck.setProps({ viewState: viewState as never });
  };

  // Warm up: first frame includes buffer upload, which is not what we measure.
  await new Promise(r => setTimeout(r, 400));
  frames = 0;
  pan(cx + (x1 - x0) * 0.25, cy + (y1 - y0) * 0.25, WINDOW_MS / 2);
  await new Promise(r => setTimeout(r, WINDOW_MS / 2));
  pan(cx - (x1 - x0) * 0.25, cy - (y1 - y0) * 0.25, WINDOW_MS / 2);
  await new Promise(r => setTimeout(r, WINDOW_MS / 2));

  const fps = Math.round((frames / (WINDOW_MS / 1000)) * 10) / 10;
  deck.finalize();
  return fps;
}

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  app.innerHTML = `<div class="bench">
    <h1>Render diagnostics</h1>
    <p class="muted">Builds deck.gl directly, one configuration at a time, to find
      what the point cloud is actually spending its frame budget on. Frames come
      from deck.gl's own <code>onAfterRender</code>; motion is a deck.gl
      transition, so the renderer sets its own pace.</p>
    <p><button id="run">Run diagnostics</button></p>
    <div id="log" class="muted"></div>
    <pre id="out">(no results yet)</pre>
    <div id="stage" style="height:520px;position:relative;border:1px solid #232838;border-radius:6px"></div>
  </div>`;

  const out = document.getElementById('out')!;
  const logEl = document.getElementById('log')!;
  const stage = document.getElementById('stage')!;
  const log = (s: string): void => {
    logEl.textContent = s;
  };

  document.getElementById('run')!.addEventListener('click', async () => {
    log(`loading ${DATASET}…`);
    const store = await loadDataset(API, DATASET);
    recolorCategorical(store, store.categoricalFields()[0]);

    const rows: string[] = [
      `dataset ${DATASET}: ${store.loadedCount.toLocaleString()} points, ` +
        `canvas ${stage.clientWidth}x${stage.clientHeight} css px, dpr ${devicePixelRatio}`,
      '',
      '| variant | fps | note |',
      '|---|---:|---|'
    ];
    for (const v of VARIANTS) {
      log(`measuring ${v.name}…`);
      const fps = await runVariant(store, v, stage);
      rows.push(`| ${v.name} | ${fps} | ${v.note} |`);
      out.textContent = rows.join('\n');
      console.log(`[diag2] ${v.name}: ${fps} fps — ${v.note}`);
    }
    log('done');
  });
}

void main();
