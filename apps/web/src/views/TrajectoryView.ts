import type { CellStore } from '@core/data/schema';
import type { PrincipalGraph } from '@core/data/manifest';
import {
  buildGraphIndex,
  closestNodes,
  degreeOf,
  nearestNode,
  nodeKind,
  nodePseudotime,
  shortestPathEdges,
  shortestPaths,
  type GraphIndex,
  type NeighborMetric
} from '@core/graph/neighbors';
import { placeLabels, type LabelPlacement } from '@core/graph/labels';
import type { Theme } from '@core/theme/themes';
import { ScatterView, type ScatterViewOptions } from './ScatterView';
import {
  buildGraphHighlightLayers,
  buildGraphLayers,
  neighborOuterPx,
  RANK_LABEL_GAP,
  rankLabelSize,
  SOURCE_RING_PX,
  type GraphHighlight
} from './graphLayers';
import { createInfoCard, type InfoCardHandle } from '../ui/InfoCard';
import { createSection } from '../ui/Section';

export interface TrajectoryViewOptions extends ScatterViewOptions {
  graph: PrincipalGraph;
}

const NODE_HIT_PX = 12;
const NODE_MARKER_PX = { root: 7, branch: 5, leaf: 3.5, internal: 2.4 } as const;
const NODE_SLACK_PX = 4;
const NODE_MIN_HIT_PX = 10;
const nodeHitPx = (kind: keyof typeof NODE_MARKER_PX): number =>
  Math.max(NODE_MIN_HIT_PX, NODE_MARKER_PX[kind] + NODE_SLACK_PX);
const KIND_LABEL = { root: 'Root', branch: 'Branch point', leaf: 'Leaf', internal: 'Node' } as const;

/** The embedding view plus a graph overlay and its own default coloring; the rest is inherited. */
export class TrajectoryView extends ScatterView {
  private graph: PrincipalGraph;
  private index: GraphIndex;
  private pseudotime: Float64Array;
  private showLabels = false;
  private showGraph = true;
  private k = 5;
  private metric: NeighborMetric = 'graph';
  private selectedNode: number | null = null;
  private hl: GraphHighlight | null = null;
  private labelKey: string | null = null;
  private nodeCard: InfoCardHandle;

  constructor(root: HTMLElement, store: CellStore, opts: TrajectoryViewOptions) {
    super(root, store, { ...opts, view: 'trajectory' });
    this.graph = opts.graph;
    this.index = buildGraphIndex(this.graph);
    this.pseudotime = nodePseudotime(this.graph, this.index);
    this.nodeCard = createInfoCard(this.holder, {
      project: (x, y) => this.canvas.worldToScreen(x, y),
      onClose: () => this.clearNode(),
      label: 'Trajectory node details',
      className: 'node-card'
    });
    this.applyGraphLayers();
    if (store.numericFields().includes('pseudotime')) {
      this.setColorBy('pseudotime', 'numeric');
    }
    this.addGraphControls();
  }

  private applyGraphLayers(): void {
    const theme = this.theme;
    this.canvas.setOverlay(
      'graph',
      this.showGraph
        ? buildGraphLayers(this.graph, { theme, showLabels: this.showLabels, muted: this.selectedNode !== null })
        : []
    );
    this.applyHighlight();
  }

  private highlight(): GraphHighlight | null {
    const source = this.selectedNode;
    if (source === null) return null;
    const paths = shortestPaths(this.index, source);
    const neighbors = closestNodes(this.graph, this.index, source, this.k, this.metric, paths);
    const edges = this.metric === 'graph' ? shortestPathEdges(paths.prev, source, neighbors.map(n => n.node)) : [];
    return { source, neighbors, edges, metric: this.metric };
  }

  private applyHighlight(): void {
    this.hl = this.showGraph ? this.highlight() : null;
    this.labelKey = null;
    if (this.hl) this.showNodeCard(this.hl);
    this.drawHighlight();
  }

  private drawHighlight(): void {
    const hl = this.hl;
    if (!hl) {
      this.canvas.setOverlay('graph-highlight', []);
      return;
    }
    const k = hl.neighbors.length;
    const sizes = hl.neighbors.map(nb => rankLabelSize(nb.rank));
    const radii = hl.neighbors.map(nb => neighborOuterPx(nb.rank, k));
    const project = (n: number): [number, number] => {
      const [x, y] = this.graph.nodes[n];
      return this.canvas.worldToScreen(x, y);
    };
    const anchors = hl.neighbors.map(nb => project(nb.node));
    const source = project(hl.source);
    const card = this.nodeCard.el;
    const blocked: [number, number, number, number][] = this.nodeCard.isOpen()
      ? [[card.offsetLeft, card.offsetTop, card.offsetLeft + card.offsetWidth, card.offsetTop + card.offsetHeight]]
      : [];
    const layout = (scale: number, hiddenBy: typeof blocked): LabelPlacement[] =>
      placeLabels(
        anchors.map(([x, y]) => [x * scale, y * scale]),
        sizes,
        RANK_LABEL_GAP,
        { radii, discs: [[source[0] * scale, source[1] * scale, SOURCE_RING_PX]], blocked: hiddenBy }
      );
    const insetZoom = this.canvas.insetZoom();
    const labels = {
      main: layout(1, blocked),
      inset: insetZoom === null ? null : layout(Math.pow(2, insetZoom - this.canvas.viewState.zoom), [])
    };
    const keyOf = (ls: readonly LabelPlacement[] | null): string =>
      ls ? ls.map(l => (l.visible ? `${l.dx},${l.dy}` : '-')).join(' ') : 'none';
    const key = `${keyOf(labels.main)}|${keyOf(labels.inset)}`;
    if (key === this.labelKey) return;
    this.labelKey = key;
    this.canvas.setOverlay('graph-highlight', buildGraphHighlightLayers(this.graph, hl, this.theme, labels));
  }

  private showNodeCard(hl: GraphHighlight): void {
    const n = hl.source;
    const kind = nodeKind(this.graph, this.index, n);
    const pt = this.pseudotime[n];
    const unit = hl.metric === 'graph' ? 'along trajectory' : 'in embedding';
    const list = hl.neighbors
      .map(nb => `<li>node ${nb.node} <span>· ${nb.distance.toFixed(2)}</span></li>`)
      .join('');
    this.nodeCard.show(
      `${KIND_LABEL[kind]} · node ${n}`,
      `<dl><dt>degree</dt><dd>${degreeOf(this.index, n)}</dd>` +
        `<dt>graph pseudotime</dt><dd>${Number.isFinite(pt) ? pt.toFixed(3) : '—'}</dd>` +
        `<dt>closest ${hl.neighbors.length}</dt><dd>${unit}</dd></dl>` +
        (list ? `<ol>${list}</ol>` : ''),
      this.graph.nodes[n]
    );
  }

  selectNode(node: number | null): void {
    this.selectedNode = node !== null && node >= 0 && node < this.graph.nodes.length ? node : null;
    if (this.selectedNode === null) this.nodeCard.hide();
    else this.clearPicked();
    this.applyGraphLayers();
  }

  private clearNode(): void {
    this.selectedNode = null;
    this.nodeCard.hide();
    this.applyGraphLayers();
  }

  protected override handleClick(x: number, y: number): void {
    if (this.showGraph) {
      const [wx, wy] = this.canvas.screenToWorld(x, y);
      const scale = Math.pow(2, this.canvas.viewState.zoom);
      const node = nearestNode(this.graph, wx, wy, NODE_HIT_PX / scale);
      if (node >= 0) {
        const [nx, ny] = this.graph.nodes[node];
        const px = Math.hypot(nx - wx, ny - wy) * scale;
        const kind = nodeKind(this.graph, this.index, node);
        if (px <= nodeHitPx(kind)) {
          this.selectNode(node);
          return;
        }
      }
    }
    if (this.selectedNode !== null) this.clearNode();
    super.handleClick(x, y);
  }

  protected override onThemeChanged(_theme: Theme): void {
    this.applyGraphLayers();
  }

  protected override repositionCards(): void {
    this.nodeCard?.reposition();
    // Runs from the base constructor too, before this class's fields exist.
    if (this.hl) this.drawHighlight();
  }

  protected override onInsetChanged(): void {
    if (this.hl) this.drawHighlight();
  }

  private addGraphControls(): void {
    const body = createSection(this.extraPanel, 'trajectory', 'Trajectory');
    const box = document.createElement('div');
    box.className = 'graph-controls';
    // Only integers are interpolated here, so no escaping is needed.
    box.innerHTML = `
      <label><input type="checkbox" data-graph checked> Show trajectory</label>
      <label><input type="checkbox" data-labels> Label root and branches</label>
      <div class="muted">${this.graph.nodes.length} nodes,
        ${this.graph.edges.length} edges,
        ${this.graph.branchPoints.length} branch points,
        ${this.graph.leaves.length} leaves</div>
      <div class="muted">Click a node to highlight its closest nodes.</div>
      <div class="row"><label for="traj-k">Closest nodes</label>
        <input id="traj-k" type="range" min="1" max="20" value="${this.k}" data-k aria-label="Number of closest nodes">
        <b data-k-readout>${this.k}</b></div>
      <div class="row" role="radiogroup" aria-label="Distance measured">
        <label><input type="radio" name="traj-metric" value="graph" checked> along trajectory</label>
        <label><input type="radio" name="traj-metric" value="euclidean"> in embedding</label>
      </div>`;
    body.appendChild(box);

    const show = box.querySelector<HTMLInputElement>('[data-graph]')!;
    const labels = box.querySelector<HTMLInputElement>('[data-labels]')!;
    const k = box.querySelector<HTMLInputElement>('[data-k]')!;
    const readout = box.querySelector<HTMLElement>('[data-k-readout]')!;
    const apply = (): void => {
      this.showGraph = show.checked;
      this.showLabels = labels.checked;
      if (!this.showGraph) this.nodeCard.hide();
      this.applyGraphLayers();
    };
    show.addEventListener('change', apply);
    labels.addEventListener('change', apply);
    k.addEventListener('input', () => {
      this.k = Number(k.value);
      readout.textContent = k.value;
      this.applyHighlight();
    });
    box.querySelectorAll<HTMLInputElement>('input[name="traj-metric"]').forEach(r =>
      r.addEventListener('change', () => {
        if (!r.checked) return;
        this.metric = r.value as NeighborMetric;
        this.applyHighlight();
      })
    );
  }

  override destroy(): void {
    this.hl = null;
    this.nodeCard.destroy();
    super.destroy();
  }
}
