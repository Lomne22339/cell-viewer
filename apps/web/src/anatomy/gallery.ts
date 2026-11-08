import '../style.css';
import { createDefaultRegistry } from '@core/anatomy/models';
import { paletteFor } from '@core/color/palette';
import { applyTheme, themeFromLocation } from '../theme';
import { renderOrgan } from './figure';
import { esc } from '../ui/escape';

/**
 * Organ gallery: every registered model, each segment in its own colour.
 *
 * This is the page an illustrator iterates against and the page the visual
 * check photographs. Distinct colours make gaps, overlaps and mislabelled
 * segments obvious in a way the data heatmap would hide.
 */
function main(): void {
  const theme = themeFromLocation();
  applyTheme(theme);
  const app = document.getElementById('app')!;
  app.innerHTML = `<div class="gallery"><h1>Organ models</h1><div class="gallery-grid"></div></div>`;
  const grid = app.querySelector('.gallery-grid')!;
  for (const model of createDefaultRegistry().list()) {
    const card = document.createElement('section');
    card.className = 'gallery-card';
    card.dataset.model = model.id;
    const palette = paletteFor(model.segments.length, theme.background);
    card.innerHTML =
      `<h2>${esc(model.label)} <span class="muted">${esc(model.view)}</span></h2>` +
      `<div class="gallery-figure"></div><ol class="gallery-key"></ol>`;
    const fig = renderOrgan(model);
    fig.setFills(s => `rgb(${palette[s * 3]},${palette[s * 3 + 1]},${palette[s * 3 + 2]})`);
    card.querySelector('.gallery-figure')!.appendChild(fig.el);
    card.querySelector('.gallery-key')!.innerHTML = model.segments
      .map(
        (seg, s) =>
          `<li><i style="background:rgb(${palette[s * 3]},${palette[s * 3 + 1]},${palette[s * 3 + 2]})"></i>` +
          `${esc(seg.label)}${seg.deep ? ' <span class="muted">(deep)</span>' : ''}` +
          `${seg.drillDown ? ` <span class="muted">→ ${esc(seg.drillDown)}</span>` : ''}</li>`
      )
      .join('');
    grid.appendChild(card);
  }
  document.body.dataset.ready = '1';
}

main();
