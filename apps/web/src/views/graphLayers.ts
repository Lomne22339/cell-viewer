import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { PrincipalGraph } from '@core/data/manifest';
import { graphNodeMarkers, graphPaths, type GraphMarker } from '@core/graph/paths';

const MARKER_STYLE: Record<
  GraphMarker['kind'],
  { color: [number, number, number, number]; radius: number }
> = {
  root: { color: [255, 255, 255, 255], radius: 7 },
  branch: { color: [255, 196, 60, 255], radius: 5 },
  leaf: { color: [140, 150, 175, 220], radius: 3.5 }
};

export interface GraphLayerOptions {
  showLabels?: boolean;
  lineWidth?: number;
}

/**
 * The trajectory backbone drawn over the cells.
 *
 * The graph is small — hundreds of nodes against hundreds of thousands of
 * cells — so it is drawn plainly, with a dark halo underneath so it stays
 * legible over a dense, bright point cloud.
 */
export function buildGraphLayers(
  graph: PrincipalGraph,
  opts: GraphLayerOptions = {}
): Layer[] {
  const paths = graphPaths(graph);
  const markers = graphNodeMarkers(graph);
  const width = opts.lineWidth ?? 2.5;

  const layers: Layer[] = [
    new PathLayer({
      id: 'graph-halo',
      data: paths,
      getPath: (d: { path: [number, number][] }) => d.path,
      getColor: [10, 12, 18, 220],
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
      getColor: [245, 245, 250, 235],
      getWidth: width,
      widthUnits: 'pixels',
      widthMinPixels: 1.5,
      capRounded: true,
      jointRounded: true,
      pickable: false
    }),
    new ScatterplotLayer({
      id: 'graph-nodes',
      data: markers,
      getPosition: (d: GraphMarker) => d.position,
      getFillColor: (d: GraphMarker) => MARKER_STYLE[d.kind].color,
      getRadius: (d: GraphMarker) => MARKER_STYLE[d.kind].radius,
      radiusUnits: 'pixels',
      stroked: true,
      getLineColor: [10, 12, 18, 255],
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
      pickable: false
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
        getColor: [235, 238, 245, 230],
        getPixelOffset: [0, -12],
        pickable: false
      })
    );
  }
  return layers;
}
