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
  type NeighbourMetric
} from '@core/graph/neighbours';
import { placeLabels, type LabelPlacement } from '@core/graph/labels';
import type { Theme } from '@core/theme/themes';
import { ScatterView, type ScatterViewOptions } from './ScatterView';
import {
  buildGraphHighlightLayers,
  buildGraphLayers,
  neighbourOuterPx,
  RANK_LABEL_GAP,
  rankLabelSize,
  SOURCE_RING_PX,
  type GraphHighlight
} from './graphLayers';
import { createInfoCard, type InfoCardHandle } from '../ui/InfoCard';
import { createSection } from '../ui/Section';
import { buildTraceLayers, type GraphTrace } from './traceLayers';

export interface TrajectoryViewOptions extends ScatterViewOptions {
  graph: PrincipalGraph;
  /**
   * Called when the user picks a node by clicking it, or closes its card
   * (null). It is not called for `selectNode`, so a host that mirrors another
   * panel's choice onto the map cannot start a loop.
   */
  onNodeSelect?: (node: number | null) => void;
}

/** Search radius for a node click; the hit itself is decided by `nodeHitPx`. */
const NODE_HIT_PX = 12;
/** Drawn marker radius per node kind, as in graphLayers.ts. */
const NODE_MARKER_PX = { root: 7, branch: 5, leaf: 3.5, internal: 2.4 } as const;
const NODE_SLACK_PX = 4;
/**
 * Every node accepts a click within 10 px (spec D1), however small its dot:
 * an internal node is drawn 2.4 px wide, and a target that small is missed
 * more often than hit. Big markers get their own radius plus slack.
 */
const NODE_MIN_HIT_PX = 10;
const nodeHitPx = (kind: keyof typeof NODE_MARKER_PX): number =>
  Math.max(NODE_MIN_HIT_PX, NODE_MARKER_PX[kind] + NODE_SLACK_PX);
const KIND_LABEL = { root: 'Root', branch: 'Branch point', leaf: 'Leaf', internal: 'Node' } as const;

/**
 * The trajectory display is the embedding display plus a graph overlay and a
 * different default colouring. Selection, zoom, the summary panel and the
 * chat wiring are inherited unchanged — that reuse is the reason the canvas
 * was built as its own class rather than folded into the embedding view.
 *
 * Clicking a node highlights the nodes closest to it (client item UI-4):
 * along the trajectory by default, or in embedding space on request.
 */
export class TrajectoryView extends ScatterView {
  private graph: PrincipalGraph;
  private index: GraphIndex;
  private pseudotime: Float64Array;
  private showLabels = false;
  private showGraph = true;
  private k = 5;
  private metric: NeighbourMetric = 'graph';
  private selectedNode: number | null = null;
  /** The highlight on screen, kept so a zoom can re-lay its rank numbers. */
  private hl: GraphHighlight | null = null;
  /** Rank-label layout last drawn, or null to force a redraw; see `drawHighlight`. */
  private labelKey: string | null = null;
  private nodeCard: InfoCardHandle;
  /** A traced path to draw over the graph, set by a host such as the protocol creator. */
  private trace: GraphTrace | null = null;
  private onNodeSelect?: (node: number | null) => void;

  constructor(root: HTMLElement, store: CellStore, opts: TrajectoryViewOptions) {
    super(root, store, { ...opts, view: 'trajectory' });
    this.graph = opts.graph;
    this.onNodeSelect = opts.onNodeSelect;
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
    const neighbours = closestNodes(this.graph, this.index, source, this.k, this.metric, paths);
    const edges = this.metric === 'graph' ? shortestPathEdges(paths.prev, source, neighbours.map(n => n.node)) : [];
    return { source, neighbours, edges, metric: this.metric };
  }

  private applyHighlight(): void {
    this.hl = this.showGraph ? this.highlight() : null;
    this.labelKey = null;
    // The card first: the rank numbers are laid out around it.
    if (this.hl) this.showNodeCard(this.hl);
    this.drawHighlight();
  }

  /**
   * Draws the highlight with its rank numbers laid out for the current zoom,
   * in the main view and in the inset. Nodes a few pixels apart cannot all
   * carry a number, so the closest ranks keep theirs and the rest come back
   * as zooming spreads the nodes. A pan moves every label alike, so it leaves
   * the layout key as it was and redraws nothing.
   */
  private drawHighlight(): void {
    const hl = this.hl;
    if (!hl) {
      this.canvas.setOverlay('graph-highlight', []);
      return;
    }
    const k = hl.neighbours.length;
    const sizes = hl.neighbours.map(nb => rankLabelSize(nb.rank));
    const radii = hl.neighbours.map(nb => neighbourOuterPx(nb.rank, k));
    const project = (n: number): [number, number] => {
      const [x, y] = this.graph.nodes[n];
      return this.canvas.worldToScreen(x, y);
    };
    const anchors = hl.neighbours.map(nb => project(nb.node));
    const source = project(hl.source);
    // A number under the node card cannot be read, so the card's area is off
    // limits in the main view. The card sits in the canvas holder, so its
    // offsets are canvas pixels.
    const card = this.nodeCard.el;
    const blocked: [number, number, number, number][] = this.nodeCard.isOpen()
      ? [[card.offsetLeft, card.offsetTop, card.offsetLeft + card.offsetWidth, card.offsetTop + card.offsetHeight]]
      : [];
    // Placement depends only on spacing, so the inset's layout is the main
    // view's screen positions scaled by the ratio of the two zooms.
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
    const list = hl.neighbours
      .map(nb => `<li>node ${nb.node} <span>· ${nb.distance.toFixed(2)}</span></li>`)
      .join('');
    this.nodeCard.show(
      `${KIND_LABEL[kind]} · node ${n}`,
      `<dl><dt>degree</dt><dd>${degreeOf(this.index, n)}</dd>` +
        `<dt>graph pseudotime</dt><dd>${Number.isFinite(pt) ? pt.toFixed(3) : '—'}</dd>` +
        `<dt>closest ${hl.neighbours.length}</dt><dd>${unit}</dd></dl>` +
        (list ? `<ol>${list}</ol>` : ''),
      this.graph.nodes[n]
    );
  }

  /** Selects a node and highlights its closest nodes. */
  selectNode(node: number | null): void {
    this.selectedNode = node !== null && node >= 0 && node < this.graph.nodes.length ? node : null;
    if (this.selectedNode === null) this.nodeCard.hide();
    else this.clearPicked();
    this.applyGraphLayers();
  }

  private clearNode(notify = true): void {
    this.selectedNode = null;
    this.nodeCard.hide();
    this.applyGraphLayers();
    if (notify) this.onNodeSelect?.(null);
  }

  /** Draws (or, with null, removes) a traced path over the graph. */
  setTrace(trace: GraphTrace | null): void {
    this.trace = trace;
    this.applyTrace();
  }

  private applyTrace(): void {
    this.canvas.setOverlay('graph-trace', this.trace ? buildTraceLayers(this.graph, this.trace, this.theme) : []);
  }

  /** Canvas position of a node, for tests and the visual check. */
  nodeScreenPosition(node: number): [number, number] | null {
    const p = this.graph.nodes[node];
    return p ? this.canvas.worldToScreen(p[0], p[1]) : null;
  }

  protected override handleClick(x: number, y: number): void {
    if (this.showGraph) {
      const [wx, wy] = this.canvas.screenToWorld(x, y);
      const scale = Math.pow(2, this.canvas.viewState.zoom);
      const node = nearestNode(this.graph, wx, wy, NODE_HIT_PX / scale);
      // Hit only within the node's hit radius, so cells lying along the
      // backbone between nodes stay clickable; zooming in spreads the nodes
      // apart and frees more of the backbone.
      if (node >= 0) {
        const [nx, ny] = this.graph.nodes[node];
        const px = Math.hypot(nx - wx, ny - wy) * scale;
        const kind = nodeKind(this.graph, this.index, node);
        if (px <= nodeHitPx(kind)) {
          this.selectNode(node);
          this.onNodeSelect?.(node);
          return;
        }
      }
    }
    // Clicking elsewhere drops the node's card but not a traced path: that
    // belongs to whoever set it.
    if (this.selectedNode !== null) this.clearNode(false);
    super.handleClick(x, y);
  }

  protected override onThemeChanged(_theme: Theme): void {
    this.applyGraphLayers();
    this.applyTrace();
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
        this.metric = r.value as NeighbourMetric;
        this.applyHighlight();
      })
    );
  }

  override destroy(): void {
    // Closing the inset during teardown must not redraw a highlight.
    this.hl = null;
    this.trace = null;
    this.nodeCard.destroy();
    super.destroy();
  }
}
