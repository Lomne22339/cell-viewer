import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { PrincipalGraph } from '@core/data/manifest';
import type { Rgb, Theme } from '@core/theme/themes';

type Rgba = [number, number, number, number];
const rgba = (c: Rgb, a = 255): Rgba => [c[0], c[1], c[2], a];

/**
 * A path back to the stem cell, as graph nodes: `path` is every node from the
 * root to the target in walking order, `marks` the last node of each
 * milestone along it, and `focus` the mark being looked at, if any.
 */
export interface GraphTrace {
  path: number[];
  marks: number[];
  focus: number | null;
}

const MARK_PX = 7;
const FOCUS_PX = 13;
const STEP_FONT_PX = 11;

/**
 * The traced path drawn over the trajectory: a haloed stroke along the path, a
 * dot where each milestone ends, the step number beside it, and a ring on the
 * step in focus. Colours come from the active theme, and everything is opaque
 * and unpickable like the rest of the graph overlay.
 */
export function buildTraceLayers(graph: PrincipalGraph, trace: GraphTrace, theme: Theme): Layer[] {
  const at = (n: number): [number, number] => graph.nodes[n];
  const layers: Layer[] = [];
  if (trace.path.length > 1) {
    const data = [{ path: trace.path.map(at) }];
    layers.push(
      new PathLayer({
        id: 'trace-halo',
        data,
        getPath: (d: { path: [number, number][] }) => d.path,
        getColor: rgba(theme.graph.halo),
        getWidth: 11,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
        pickable: false
      }),
      new PathLayer({
        id: 'trace-line',
        data,
        getPath: (d: { path: [number, number][] }) => d.path,
        getColor: rgba(theme.highlight),
        getWidth: 5,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
        pickable: false
      })
    );
  }
  const marks = trace.marks.map((node, i) => ({ node, step: i + 1 }));
  layers.push(
    new ScatterplotLayer({
      id: 'trace-marks',
      data: marks,
      getPosition: (d: { node: number }) => at(d.node),
      getRadius: MARK_PX,
      radiusUnits: 'pixels',
      getFillColor: rgba(theme.highlight),
      stroked: true,
      getLineColor: rgba(theme.graph.halo),
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      pickable: false
    }),
    new TextLayer({
      id: 'trace-steps',
      data: marks,
      getPosition: (d: { node: number }) => at(d.node),
      getText: (d: { step: number }) => String(d.step),
      getSize: STEP_FONT_PX,
      sizeUnits: 'pixels',
      getColor: rgba(theme.highlight),
      fontWeight: 700,
      background: true,
      getBackgroundColor: rgba(theme.background),
      backgroundPadding: [3, 1],
      getPixelOffset: [MARK_PX + 9, -(MARK_PX + 7)],
      pickable: false
    })
  );
  if (trace.focus !== null && trace.marks[trace.focus] !== undefined) {
    layers.push(
      new ScatterplotLayer({
        id: 'trace-focus',
        data: [trace.marks[trace.focus]],
        getPosition: (n: number) => at(n),
        getRadius: FOCUS_PX,
        radiusUnits: 'pixels',
        filled: false,
        stroked: true,
        getLineColor: rgba(theme.ring),
        lineWidthUnits: 'pixels',
        getLineWidth: 3,
        pickable: false
      })
    );
  }
  return layers;
}
