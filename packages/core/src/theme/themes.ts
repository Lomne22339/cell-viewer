/**
 * Background themes.
 *
 * The client asked for four backgrounds — black, white, grey and light yellow
 * — "dark mode, light mode, solarised". A theme is more than a canvas colour:
 * selection dimming fades cells *toward the background*, and the trajectory
 * overlay, highlights and rings must stay legible on it. Those colours live
 * here, as data, so their contrast can be unit-tested rather than eyeballed.
 * The DOM side mirrors the same ids as CSS custom properties.
 */
export type Rgb = [number, number, number];

export type ThemeId = 'black' | 'white' | 'grey' | 'yellow';

export interface Theme {
  id: ThemeId;
  /** Shown on the picker button. */
  label: string;
  /** Longer description for the tooltip. */
  hint: string;
  mode: 'dark' | 'light';
  /** Plot background. Unselected cells fade toward this. */
  background: Rgb;
  /** How far an unselected cell keeps its own colour (0 = background, 1 = none). */
  dimFactor: number;
  graph: {
    path: Rgb;
    /** Drawn under the path so it separates from a dense point cloud. */
    halo: Rgb;
    node: Rgb;
    root: Rgb;
    branch: Rgb;
    leaf: Rgb;
  };
  /** Nodes and edges highlighted by a trajectory click. */
  highlight: Rgb;
  /** Selection outlines, the inset marker, focused controls. */
  accent: Rgb;
  /** Ring around a clicked cell or node. */
  ring: Rgb;
  /** Side-panel background, which the anatomy figure is drawn on. */
  panel: Rgb;
  /**
   * Anatomy shading from "no cells" to "most cells". The first stop must stay
   * distinguishable from the panel so an empty region never vanishes.
   */
  heat: Rgb[];
  /** Point colour for a dataset with no annotation to colour by. */
  pointDefault: Rgb;
  /** In-progress box/lasso outline and fill. */
  selectionPreview: Rgb;
}

export const THEMES: readonly Theme[] = [
  {
    id: 'black',
    label: 'Black',
    hint: 'Dark mode — black background',
    mode: 'dark',
    background: [0, 0, 0],
    dimFactor: 0.22,
    graph: {
      path: [240, 242, 248],
      halo: [12, 14, 20],
      node: [196, 202, 216],
      root: [255, 255, 255],
      branch: [255, 196, 60],
      leaf: [150, 160, 185]
    },
    highlight: [255, 79, 163],
    accent: [79, 147, 255],
    ring: [255, 255, 255],
    panel: [18, 21, 29],
    heat: [[52, 61, 84], [118, 66, 178], [255, 79, 163], [255, 214, 102]],
    pointDefault: [150, 180, 235],
    selectionPreview: [120, 190, 255]
  },
  {
    id: 'white',
    label: 'White',
    hint: 'Light mode — white background',
    mode: 'light',
    background: [255, 255, 255],
    dimFactor: 0.22,
    graph: {
      path: [28, 32, 44],
      halo: [255, 255, 255],
      node: [70, 78, 95],
      root: [0, 0, 0],
      branch: [180, 83, 9],
      leaf: [96, 106, 126]
    },
    highlight: [199, 0, 102],
    accent: [29, 92, 220],
    ring: [0, 0, 0],
    panel: [255, 255, 255],
    heat: [[214, 204, 222], [196, 130, 206], [199, 0, 102], [86, 0, 60]],
    pointDefault: [70, 90, 140],
    selectionPreview: [29, 92, 220]
  },
  {
    id: 'grey',
    label: 'Grey',
    hint: 'Grey background (ggplot2 grey92)',
    mode: 'light',
    background: [235, 235, 235],
    dimFactor: 0.22,
    graph: {
      path: [28, 32, 44],
      halo: [250, 250, 250],
      node: [64, 72, 88],
      root: [0, 0, 0],
      branch: [168, 72, 0],
      leaf: [88, 98, 118]
    },
    highlight: [190, 0, 96],
    accent: [26, 84, 204],
    ring: [0, 0, 0],
    panel: [244, 244, 244],
    heat: [[206, 196, 214], [190, 124, 200], [190, 0, 96], [80, 0, 56]],
    pointDefault: [64, 82, 130],
    selectionPreview: [26, 84, 204]
  },
  {
    id: 'yellow',
    label: 'Light yellow',
    hint: 'Solarised — light yellow background',
    mode: 'light',
    background: [253, 246, 227],
    dimFactor: 0.22,
    graph: {
      path: [7, 54, 66],
      halo: [253, 246, 227],
      node: [70, 96, 104],
      root: [0, 43, 54],
      branch: [176, 62, 14],
      leaf: [88, 110, 117]
    },
    highlight: [181, 37, 108],
    accent: [33, 118, 181],
    ring: [0, 43, 54],
    panel: [253, 246, 227],
    heat: [[221, 207, 186], [204, 140, 160], [181, 37, 108], [88, 20, 64]],
    pointDefault: [38, 98, 128],
    selectionPreview: [33, 118, 181]
  }
];

export const DEFAULT_THEME_ID: ThemeId = 'black';

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEMES.some(t => t.id === value);
}

export function getTheme(id: string | null | undefined): Theme {
  return THEMES.find(t => t.id === id) ?? THEMES.find(t => t.id === DEFAULT_THEME_ID)!;
}

/** WCAG 2.x relative luminance of an sRGB colour. */
export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, from 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Opacity (0–255) of each trajectory overlay layer as drawn: the halo under
 * the backbone, the backbone itself, the small dot on every node and the
 * root/branch/leaf markers. They live here, beside the colours, because the
 * contrast that matters is that of the blended result, not the opaque theme
 * colour.
 */
export const GRAPH_ALPHA = { halo: 220, path: 235, node: 230, marker: 255 } as const;

/**
 * Multiplier on every `GRAPH_ALPHA` while a node's neighbourhood is
 * highlighted. The backbone steps back so the highlight leads, but stays at
 * 3:1 or better on every background (tested), so it never disappears.
 */
export const GRAPH_MUTED = 0.75;

/** `fg` drawn at `alpha` (0–1) over an opaque `bg`, as the GPU blends it. */
export function blendOver(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  const a = Math.min(1, Math.max(0, alpha));
  return [0, 1, 2].map(k => Math.round(fg[k] * a + bg[k] * (1 - a))) as Rgb;
}

/** `#rrggbb`, for the DOM side and for tests that compare against CSS. */
export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')}`;
}
