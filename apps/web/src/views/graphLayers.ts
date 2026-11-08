import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { PrincipalGraph } from '@core/data/manifest';
import { graphNodeMarkers, graphPaths, type GraphMarker } from '@core/graph/paths';
import type { LabelPlacement } from '@core/graph/labels';
import type { Neighbour, NeighbourMetric } from '@core/graph/neighbours';
import { GRAPH_ALPHA, GRAPH_MUTED, type Rgb, type Theme } from '@core/theme/themes';

type Rgba = [number, number, number, number];
type RankLabel = { nb: Neighbour; offset: [number, number] };
const rgba = (c: Rgb, a = 255): Rgba => [c[0], c[1], c[2], a];

export interface GraphLayerOptions {
  theme: Theme;
  showLabels?: boolean;
  lineWidth?: number;
  /** Fade the backbone while a node's neighbourhood is highlighted. */
  muted?: boolean;
}

/**
 * The trajectory backbone drawn over the cells.
 *
 * The graph is small — hundreds of nodes against hundreds of thousands of
 * cells — so it is drawn plainly, with a halo underneath so it stays legible
 * over a dense point cloud. Every node is drawn, not only the root, branch
 * points and leaves, because every node can be clicked (client item UI-4).
 * All colours come from the theme, so the overlay reads on black, white,
 * grey and light yellow alike.
 */
export function buildGraphLayers(graph: PrincipalGraph, opts: GraphLayerOptions): Layer[] {
  const { theme } = opts;
  const paths = graphPaths(graph);
  const markers = graphNodeMarkers(graph);
  const width = opts.lineWidth ?? 2.5;
  const a = opts.muted ? GRAPH_MUTED : 1;
  const markerColor: Record<GraphMarker['kind'], Rgb> = {
    root: theme.graph.root,
    branch: theme.graph.branch,
    leaf: theme.graph.leaf
  };
  const markerRadius: Record<GraphMarker['kind'], number> = { root: 7, branch: 5, leaf: 3.5 };

  const layers: Layer[] = [
    new PathLayer({
      id: 'graph-halo',
      data: paths,
      getPath: (d: { path: [number, number][] }) => d.path,
      getColor: rgba(theme.graph.halo, GRAPH_ALPHA.halo * a),
      getWidth: width + 3,
      widthUnits: 'pixels',
      widthMinPixels: 3,
      capRounded: true,
      jointRounded: true,
      pickable: false
    }),
    new PathLayer({
      id: 'graph-path',
      data: paths,
      getPath: (d: { path: [number, number][] }) => d.path,
      getColor: rgba(theme.graph.path, GRAPH_ALPHA.path * a),
      getWidth: width,
      widthUnits: 'pixels',
      widthMinPixels: 1.5,
      capRounded: true,
      jointRounded: true,
      pickable: false,
      updateTriggers: { getColor: [theme.id, a] }
    }),
    new ScatterplotLayer({
      id: 'graph-allnodes',
      data: graph.nodes,
      getPosition: (d: [number, number]) => d,
      getFillColor: rgba(theme.graph.node, GRAPH_ALPHA.node * a),
      getRadius: 2.4,
      radiusUnits: 'pixels',
      stroked: true,
      getLineColor: rgba(theme.graph.halo, GRAPH_ALPHA.node * a),
      lineWidthUnits: 'pixels',
      getLineWidth: 0.8,
      pickable: false,
      updateTriggers: { getFillColor: [theme.id, a], getLineColor: [theme.id, a] }
    }),
    new ScatterplotLayer({
      id: 'graph-nodes',
      data: markers,
      getPosition: (d: GraphMarker) => d.position,
      getFillColor: (d: GraphMarker) => rgba(markerColor[d.kind], GRAPH_ALPHA.marker * a),
      getRadius: (d: GraphMarker) => markerRadius[d.kind],
      radiusUnits: 'pixels',
      stroked: true,
      getLineColor: rgba(theme.graph.halo, 255),
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
      pickable: false,
      updateTriggers: { getFillColor: [theme.id, a], getLineColor: theme.id }
    })
  ];

  if (opts.showLabels) {
    layers.push(
      new TextLayer({
        id: 'graph-labels',
        data: markers.filter(m => m.kind !== 'leaf'),
        getPosition: (d: GraphMarker) => d.position,
        getText: (d: GraphMarker) => (d.kind === 'root' ? 'root' : 'branch'),
        getSize: 11,
        sizeUnits: 'pixels',
        getColor: rgba(theme.graph.path, 240),
        background: true,
        getBackgroundColor: rgba(theme.background, 200),
        backgroundPadding: [3, 1],
        getPixelOffset: [0, -13],
        pickable: false,
        updateTriggers: { getColor: theme.id, getBackgroundColor: theme.id }
      })
    );
  }
  return layers;
}

export interface GraphHighlight {
  source: number;
  neighbours: Neighbour[];
  /** Shortest-path edges joining the source to its neighbours (graph metric). */
  edges: [number, number][];
  metric: NeighbourMetric;
}

/** Rank numbers: 11 px bold monospace on a padded background chip. */
const RANK_FONT_PX = 11;
const RANK_CHAR_PX = 0.6 * RANK_FONT_PX;
const RANK_PAD: [number, number] = [3, 1];
/** Clearance between a neighbour's centre and the nearest edge of its rank chip. */
export const RANK_LABEL_GAP = 4.5;

/**
 * On-screen size of a rank chip, with a pixel of margin on every side so two
 * chips never sit flush against each other.
 */
export function rankLabelSize(rank: number): [number, number] {
  return [
    String(rank).length * RANK_CHAR_PX + 2 * RANK_PAD[0] + 2,
    RANK_FONT_PX + 2 * RANK_PAD[1] + 2
  ];
}

/** Drawn radius of the rank-`rank` neighbour of `k`: closer ones are larger. */
export function neighbourRadiusPx(rank: number, k: number): number {
  return 8 - (4 * (rank - 1)) / Math.max(1, k);
}
const NEIGHBOUR_STROKE_PX = 1.5;
const SOURCE_RADIUS_PX = 11;
const SOURCE_STROKE_PX = 2.5;
/** Outer radius of the clicked node's ring, stroke included, for label avoidance. */
export const SOURCE_RING_PX = SOURCE_RADIUS_PX + SOURCE_STROKE_PX / 2;
/** Outer radius of a neighbour's disc, stroke included, for label avoidance. */
export const neighbourOuterPx = (rank: number, k: number): number =>
  neighbourRadiusPx(rank, k) + NEIGHBOUR_STROKE_PX / 2;

/** Rank layout for the main view and, while a zoom or overview inset is open, the inset. */
export interface RankLabels {
  main?: readonly LabelPlacement[];
  inset?: readonly LabelPlacement[] | null;
}

/**
 * The rank numbers for one view. `labels`, parallel to `hl.neighbours`, says
 * which numbers fit at that view's zoom and on which side; without it every
 * number is drawn up and to the right.
 */
function rankLayer(
  id: string,
  graph: PrincipalGraph,
  hl: GraphHighlight,
  theme: Theme,
  labels?: readonly LabelPlacement[]
): TextLayer<RankLabel> {
  const ranks = hl.neighbours.flatMap((nb, i): RankLabel[] => {
    const at = labels?.[i];
    if (at && !at.visible) return [];
    const [w, h] = rankLabelSize(nb.rank);
    return [{ nb, offset: at ? [at.dx, at.dy] : [RANK_LABEL_GAP + w / 2, -(RANK_LABEL_GAP + h / 2)] }];
  });
  return new TextLayer<RankLabel>({
    id,
    data: ranks,
    getPosition: d => graph.nodes[d.nb.node],
    getText: d => String(d.nb.rank),
    getSize: RANK_FONT_PX,
    sizeUnits: 'pixels',
    getColor: rgba(theme.highlight),
    fontWeight: 700,
    background: true,
    getBackgroundColor: rgba(theme.background, 225),
    backgroundPadding: RANK_PAD,
    getPixelOffset: d => d.offset,
    pickable: false
  });
}

/**
 * The clicked node and its closest nodes: the joining stretch of trajectory
 * (or straight connectors, for the embedding metric), neighbours sized and
 * numbered by rank, and a ring on the clicked node.
 *
 * The rank numbers are laid out per view, because a number that has no room
 * in the main view may well have room in the magnified inset: `hl-ranks` is
 * drawn in the main view only and `inset:hl-ranks` in the inset only.
 */
export function buildGraphHighlightLayers(
  graph: PrincipalGraph,
  hl: GraphHighlight,
  theme: Theme,
  labels: RankLabels = {}
): Layer[] {
  const src = graph.nodes[hl.source];
  if (!src) return [];
  const k = Math.max(1, hl.neighbours.length);
  const segments =
    hl.metric === 'graph'
      ? hl.edges.map(([u, v]) => ({ path: [graph.nodes[u], graph.nodes[v]] }))
      : hl.neighbours.map(n => ({ path: [src, graph.nodes[n.node]] }));

  return [
    new PathLayer({
      id: 'graph-hl-halo',
      data: segments,
      getPath: (d: { path: [number, number][] }) => d.path,
      getColor: rgba(theme.graph.halo, 230),
      getWidth: hl.metric === 'graph' ? 9 : 5,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      pickable: false
    }),
    new PathLayer({
      id: 'graph-hl-path',
      data: segments,
      getPath: (d: { path: [number, number][] }) => d.path,
      getColor: rgba(theme.highlight, hl.metric === 'graph' ? 255 : 200),
      getWidth: hl.metric === 'graph' ? 5 : 2,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      pickable: false
    }),
    new ScatterplotLayer({
      id: 'graph-hl-nodes',
      data: hl.neighbours,
      getPosition: (d: Neighbour) => graph.nodes[d.node],
      // Closer neighbours are drawn larger, so rank reads without the labels.
      getRadius: (d: Neighbour) => neighbourRadiusPx(d.rank, k),
      radiusUnits: 'pixels',
      getFillColor: rgba(theme.highlight),
      stroked: true,
      getLineColor: rgba(theme.graph.halo),
      lineWidthUnits: 'pixels',
      getLineWidth: NEIGHBOUR_STROKE_PX,
      pickable: false
    }),
    new ScatterplotLayer({
      id: 'graph-hl-source',
      data: [src],
      getPosition: (d: [number, number]) => d,
      getRadius: SOURCE_RADIUS_PX,
      radiusUnits: 'pixels',
      filled: true,
      getFillColor: rgba(theme.highlight, 90),
      stroked: true,
      getLineColor: rgba(theme.ring),
      lineWidthUnits: 'pixels',
      getLineWidth: SOURCE_STROKE_PX,
      pickable: false
    }),
    rankLayer('hl-ranks', graph, hl, theme, labels.main),
    ...(labels.inset ? [rankLayer('inset:hl-ranks', graph, hl, theme, labels.inset)] : [])
  ];
}
