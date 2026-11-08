import { describe, expect, it } from 'vitest';
import {
  blendOver,
  contrastRatio,
  getTheme,
  GRAPH_ALPHA,
  GRAPH_MUTED,
  isThemeId,
  relativeLuminance,
  THEMES,
  toHex
} from '@core/theme/themes';

describe('themes', () => {
  it('offers exactly the four requested backgrounds', () => {
    expect(THEMES.map(t => t.id)).toEqual(['black', 'white', 'grey', 'yellow']);
    expect(toHex(getTheme('black').background)).toBe('#000000');
    expect(toHex(getTheme('white').background)).toBe('#ffffff');
    expect(toHex(getTheme('grey').background)).toBe('#ebebeb');
    expect(toHex(getTheme('yellow').background)).toBe('#fdf6e3');
  });

  it('falls back to the default for an unknown id', () => {
    expect(getTheme('nope').id).toBe('black');
    expect(getTheme(null).id).toBe('black');
    expect(isThemeId('grey')).toBe(true);
    expect(isThemeId('purple')).toBe(false);
  });

  it('computes WCAG luminance and contrast', () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1);
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21);
    expect(contrastRatio([10, 20, 30], [10, 20, 30])).toBeCloseTo(1);
  });

  it('blends a colour over a background as the GPU does', () => {
    expect(blendOver([255, 255, 255], [0, 0, 0], 1)).toEqual([255, 255, 255]);
    expect(blendOver([255, 255, 255], [0, 0, 0], 0)).toEqual([0, 0, 0]);
    expect(blendOver([200, 100, 0], [0, 100, 200], 0.5)).toEqual([100, 100, 100]);
  });

  // B3: overlays must read on every background, not just the dark default.
  for (const theme of THEMES) {
    it(`${theme.id}: graph strokes, markers, highlight and ring have >= 3:1 contrast`, () => {
      const bg = theme.background;
      const checks: [string, [number, number, number]][] = [
        ['path', theme.graph.path],
        ['node', theme.graph.node],
        ['root', theme.graph.root],
        ['branch', theme.graph.branch],
        ['leaf', theme.graph.leaf],
        ['highlight', theme.highlight],
        ['accent', theme.accent],
        ['ring', theme.ring]
      ];
      for (const [name, rgb] of checks) {
        expect(contrastRatio(rgb, bg), `${theme.id}.${name}`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`${theme.id}: default points and the selection outline read on the background`, () => {
      expect(contrastRatio(theme.pointDefault, theme.background)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(theme.selectionPreview, theme.background)).toBeGreaterThanOrEqual(3);
    });

    it(`${theme.id}: anatomy shading never vanishes into the panel`, () => {
      // An empty region is the lowest stop: faint but still visible.
      expect(contrastRatio(theme.heat[0], theme.panel)).toBeGreaterThanOrEqual(1.25);
      // The densest region is unmistakable.
      expect(contrastRatio(theme.heat[theme.heat.length - 1], theme.panel)).toBeGreaterThanOrEqual(3);
    });

    it(`${theme.id}: the backbone stays at 3:1 as drawn, translucent and muted included`, () => {
      // B3 as the GPU sees it: each layer blended at its real opacity, both
      // normally and while a node highlight mutes the backbone (UI-4).
      const bg = theme.background;
      for (const k of [1, GRAPH_MUTED]) {
        const under = blendOver(theme.graph.halo, bg, (GRAPH_ALPHA.halo * k) / 255);
        const drawn: [string, [number, number, number]][] = [
          ['path', blendOver(theme.graph.path, under, (GRAPH_ALPHA.path * k) / 255)],
          ['node', blendOver(theme.graph.node, bg, (GRAPH_ALPHA.node * k) / 255)],
          ['root', blendOver(theme.graph.root, bg, (GRAPH_ALPHA.marker * k) / 255)],
          ['branch', blendOver(theme.graph.branch, bg, (GRAPH_ALPHA.marker * k) / 255)],
          ['leaf', blendOver(theme.graph.leaf, bg, (GRAPH_ALPHA.marker * k) / 255)]
        ];
        for (const [name, rgb] of drawn) {
          expect(contrastRatio(rgb, bg), `${theme.id}.${name} at ×${k}`).toBeGreaterThanOrEqual(3);
        }
      }
    });

    it(`${theme.id}: the halo separates the path from the points`, () => {
      expect(contrastRatio(theme.graph.path, theme.graph.halo)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
