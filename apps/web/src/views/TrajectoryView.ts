import type { CellStore } from '@core/data/schema';
import type { PrincipalGraph } from '@core/data/manifest';
import { ScatterView, type ScatterViewOptions } from './ScatterView';
import { buildGraphLayers } from './graphLayers';

export interface TrajectoryViewOptions extends ScatterViewOptions {
  graph: PrincipalGraph;
}

/**
 * The trajectory display is the embedding display plus a graph overlay and a
 * different default colouring. Selection, zoom, the summary panel and the
 * chat wiring are inherited unchanged — that reuse is the reason the canvas
 * was built as its own class rather than folded into the embedding view.
 */
export class TrajectoryView extends ScatterView {
  private graph: PrincipalGraph;
  private showLabels = false;
  private showGraph = true;

  constructor(root: HTMLElement, store: CellStore, opts: TrajectoryViewOptions) {
    super(root, store, { ...opts, view: 'trajectory' });
    this.graph = opts.graph;
    this.applyGraphLayers();
    if (store.numericFields().includes('pseudotime')) {
      this.setColorBy('pseudotime', 'numeric');
    }
    this.addGraphControls();
  }

  private applyGraphLayers(): void {
    this.canvas.setOverlayLayers(
      this.showGraph ? buildGraphLayers(this.graph, { showLabels: this.showLabels }) : []
    );
  }

  private addGraphControls(): void {
    const box = document.createElement('div');
    box.className = 'graph-controls';
    // Only integers are interpolated here, so no escaping is needed.
    box.innerHTML = `
      <label><input type="checkbox" data-graph checked> Show trajectory</label>
      <label><input type="checkbox" data-labels> Label root and branches</label>
      <div class="muted">${this.graph.nodes.length} nodes,
        ${this.graph.edges.length} edges,
        ${this.graph.branchPoints.length} branch points,
        ${this.graph.leaves.length} leaves</div>`;
    this.side.appendChild(box);

    const show = box.querySelector<HTMLInputElement>('[data-graph]')!;
    const labels = box.querySelector<HTMLInputElement>('[data-labels]')!;
    const apply = (): void => {
      this.showGraph = show.checked;
      this.showLabels = labels.checked;
      this.applyGraphLayers();
    };
    show.addEventListener('change', apply);
    labels.addEventListener('change', apply);
  }
}
