#!/usr/bin/env node
/**
 * A scripted human walkthrough of every page and every control.
 *
 *   node scripts/walkthrough.mjs                # everything
 *   node scripts/walkthrough.mjs --only legend  # one tour
 *
 * Each step saves a numbered screenshot to test-results/walkthrough/ and the
 * run ends with test-results/walkthrough/report.json: per step, what was done,
 * what was expected, what the page actually showed (a few DOM facts), and any
 * console errors or page exceptions raised during the step. Nothing here
 * asserts — it records, so a person (or an agent with an image reader) can
 * look at what really happened and judge it.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { chromium } from '@playwright/test';

const API = 'http://localhost:8000';
const WEB = 'http://localhost:5173';
const OUT = 'test-results/walkthrough';
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 ? process.argv[i + 1] : null;
})();

const children = [];
const up = async url => {
  try {
    const r = await fetch(url);
    return r.status < 500;
  } catch {
    return false;
  }
};
async function ensureServer(url, cmd, args) {
  if (await up(url)) return;
  children.push(spawn(cmd, args, { stdio: 'ignore' }));
  for (let i = 0; i < 120; i++) {
    if (await up(url)) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`server did not come up: ${url}`);
}
process.on('exit', () => children.forEach(c => c.kill()));

const report = [];
let stepNo = 0;

/** One recorded step: act, wait, screenshot, and capture DOM facts and errors. */
async function step(page, tour, name, expected, act, settleMs = 700) {
  const errors = [];
  const onConsole = m => {
    if (m.type() === 'error' && !m.text().includes('GL Driver')) errors.push(`console: ${m.text()}`);
  };
  const onError = e => errors.push(`pageerror: ${e.message}`);
  page.on('console', onConsole);
  page.on('pageerror', onError);
  let actError = null;
  const t0 = Date.now();
  try {
    await act();
  } catch (err) {
    actError = err instanceof Error ? err.message.split('\n')[0] : String(err);
  }
  await page.waitForTimeout(settleMs);
  const file = `${OUT}/${String(++stepNo).padStart(3, '0')}-${tour}-${name}.png`;
  await page.screenshot({ path: file }).catch(() => {});
  const facts = await page
    .evaluate(() => {
      const q = s => document.querySelector(s);
      const visible = s => {
        const el = q(s);
        return !!el && !el.hidden && el.getClientRects().length > 0;
      };
      return {
        theme: document.documentElement.dataset.theme,
        status: q('#status')?.textContent ?? null,
        summary: q('.summary')?.textContent?.trim().slice(0, 160) ?? null,
        legendCount: q('.legend-count')?.textContent ?? null,
        chatBadge: q('.chat-badge')?.textContent ?? null,
        cellCard: visible('.cell-card:not(.node-card)') ? q('.cell-card:not(.node-card)').textContent.slice(0, 120) : null,
        nodeCard: visible('.node-card') ? q('.node-card').textContent.slice(0, 160) : null,
        inset: visible('.inset-frame') ? q('.inset-frame .modes [aria-pressed="true"]')?.textContent : null,
        insetMag: q('.inset-frame .mag')?.textContent ?? null,
        connectors: document.querySelectorAll('.inset-connectors line').length,
        anatomyCrumbs: q('.anatomy-crumbs')?.textContent?.trim() ?? null,
        anatomyActions: q('.anatomy-actions')?.textContent?.trim().slice(0, 140) ?? null,
        lod: q('.lod-readout')?.textContent ?? null,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })
    .catch(e => ({ evalError: String(e) }));
  page.off('console', onConsole);
  page.off('pageerror', onError);
  report.push({ step: stepNo, tour, name, expected, file, ms: Date.now() - t0, actError, errors, facts });
  console.log(`${file}${actError ? `  ACT-ERROR: ${actError}` : ''}${errors.length ? `  ERRORS: ${errors.length}` : ''}`);
}

async function load(page, url, statusText) {
  await page.goto(`${WEB}${url}`);
  await page.waitForFunction(t => (document.getElementById('status')?.textContent ?? '').endsWith(t), statusText, {
    timeout: 120_000
  });
  await page.waitForTimeout(1200); // let deck.gl finish initialising its device
}

async function canvasBox(page) {
  return page.locator('.canvas-holder canvas').first().boundingBox();
}

async function drag(page, from, to, steps = 6) {
  const b = await canvasBox(page);
  await page.mouse.move(b.x + from[0], b.y + from[1]);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(b.x + from[0] + ((to[0] - from[0]) * i) / steps, b.y + from[1] + ((to[1] - from[1]) * i) / steps);
  }
  await page.mouse.up();
}

async function clickUntil(page, selector) {
  const b = await canvasBox(page);
  for (let i = 0; i < 30; i++) {
    await page.mouse.click(b.x + b.width * (0.35 + (i % 6) * 0.06), b.y + b.height * (0.35 + Math.floor(i / 6) * 0.06));
    const ok = await page.locator(selector).waitFor({ state: 'visible', timeout: 1200 }).then(() => true, () => false);
    if (ok) return true;
  }
  return false;
}

const tours = {
  async basics(browser) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await step(page, 'basics', 'open-default', 'Default dataset opens (1M UMAP), status shows the cell count, legend lists 20 cell types, no errors', async () => {
      await page.goto(WEB);
      await page.waitForFunction(() => /cells$/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 120_000 });
    }, 1500);
    await step(page, 'basics', 'switch-100k', 'Switcher opens the 100k UMAP; side panel rebuilds; status 100,000 cells', async () => {
      await page.getByRole('button', { name: /UMAP · 100k/ }).click();
      await page.waitForFunction(() => (document.getElementById('status')?.textContent ?? '') === '100,000 cells', null, { timeout: 120_000 });
    }, 1200);
    await step(page, 'basics', 'hover', 'Moving the pointer across the plot shows nothing (no tooltip, no card)', async () => {
      const b = await canvasBox(page);
      for (let i = 0; i < 10; i++) await page.mouse.move(b.x + 100 + i * 60, b.y + b.height / 2);
    });
    await step(page, 'basics', 'click-cell', 'Click on a cell opens a pinned card at the click point with every field; a ring marks the cell', async () => {
      await clickUntil(page, '.cell-card:not([hidden])');
    });
    await step(page, 'basics', 'pan-with-card', 'Dragging (pan mode) moves the plot; the card follows its cell', async () => {
      await drag(page, [300, 300], [380, 340]);
    });
    await step(page, 'basics', 'escape-card', 'Escape closes the card and the ring', async () => {
      await page.keyboard.press('Escape');
    });
    await step(page, 'basics', 'wheel-zoom', 'Mouse wheel zooms around the cursor', async () => {
      const b = await canvasBox(page);
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.wheel(0, -600);
    }, 1200);
    await step(page, 'basics', 'reset-view', 'Reset view frames the whole dataset again', async () => {
      await page.getByRole('button', { name: 'Reset view' }).click();
    }, 1200);
    await step(page, 'basics', 'box-select', 'Box drag selects cells; others dim; summary shows the count and composition; chat input enabled', async () => {
      await page.getByRole('button', { name: 'Box', exact: true }).click();
      await drag(page, [250, 180], [560, 470]);
      await page.waitForSelector('.summary-head', { timeout: 20_000 });
    }, 1000);
    await step(page, 'basics', 'zoom-to-selection', 'Zoom to selection frames the selected region', async () => {
      await page.getByRole('button', { name: 'Zoom to selection' }).click();
    }, 1500);
    await step(page, 'basics', 'lasso', 'Lasso replaces the selection with a freehand region', async () => {
      await page.getByRole('button', { name: 'Reset view' }).click();
      await page.waitForTimeout(800);
      await page.getByRole('button', { name: 'Lasso', exact: true }).click();
      const b = await canvasBox(page);
      const cx = b.width / 2;
      const cy = b.height / 2;
      await page.mouse.move(b.x + cx + 160, b.y + cy);
      await page.mouse.down();
      for (let k = 1; k <= 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        await page.mouse.move(b.x + cx + Math.cos(a) * 160, b.y + cy + Math.sin(a) * 120);
      }
      await page.mouse.up();
      await page.waitForTimeout(1500);
    }, 1000);
    await step(page, 'basics', 'chat', 'Asking "how many cells are selected?" streams an answer quoting the selected count', async () => {
      await page.locator('.chat-input textarea').fill('how many cells are selected?');
      await page.getByRole('button', { name: 'Ask' }).click();
      await page.waitForTimeout(1500);
    });
    await step(page, 'basics', 'colour-by-tissue', 'Colour by tissue recolours the plot and the legend; the selection survives', async () => {
      await page.locator('.colorby select').selectOption('c:tissue');
    }, 1000);
    await step(page, 'basics', 'colour-by-pseudotime', 'Colour by pseudotime shows the viridis ramp legend', async () => {
      await page.locator('.colorby select').selectOption('n:pseudotime');
    }, 1000);
    await step(page, 'basics', 'clear', 'Clear removes the selection; summary says no cells selected; chat input disabled', async () => {
      await page.getByRole('button', { name: 'Clear' }).click();
    });
    await step(page, 'basics', 'lod-manual', 'Unticking Auto detail and dragging the slider to 10% draws 10,000 points', async () => {
      await page.getByRole('button', { name: 'Pan', exact: true }).click();
      await page.locator('.lod input[type=checkbox]').uncheck();
      await page.locator('.lod input[type=range]').fill('10');
      await page.locator('.lod input[type=range]').dispatchEvent('input');
    });
    await step(page, 'basics', 'translucent', 'Translucent points shows density shading without losing anything', async () => {
      await page.locator('.lod input[type=checkbox]').check();
      await page.locator('.render-control input[data-blend]').check();
    }, 1000);
    await step(page, 'basics', 'translucent-off', 'Turning translucency off returns to opaque points', async () => {
      await page.locator('.render-control input[data-blend]').uncheck();
    }, 1000);
    await page.close();
  },

  async themes(browser) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await load(page, '/?dataset=sim100k', '100,000 cells');
    await page.getByRole('button', { name: 'Box', exact: true }).click();
    await drag(page, [250, 180], [560, 470]);
    await page.waitForSelector('.summary-head', { timeout: 20_000 });
    for (const name of ['White', 'Grey', 'Light yellow', 'Black']) {
      await step(page, 'themes', name.toLowerCase().replace(' ', '-'), `${name}: plot and whole interface restyle; dimmed cells fade toward the background; text legible; selection kept`, async () => {
        await page.locator('.theme-picker button', { hasText: name }).click();
      }, 1000);
    }
    await step(page, 'themes', 'reload-keeps', 'Reloading keeps the last background (black)', async () => {
      await page.locator('.theme-picker button', { hasText: 'Grey' }).click();
      await load(page, '/?dataset=sim100k', '100,000 cells');
    }, 800);
    await page.close();
  },

  async legend(browser) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await load(page, '/?dataset=sim100k', '100,000 cells');
    const rows = page.locator('.legend-row');
    await step(page, 'legend', 'click-hide', 'Clicking the first legend row hides that cell type (row struck through, "19 of 20 shown")', async () => {
      await rows.first().click();
    }, 900);
    await step(page, 'legend', 'click-show', 'Clicking it again shows it ("20 of 20 shown")', async () => {
      await rows.first().click();
    }, 900);
    await step(page, 'legend', 'dblclick-isolate', 'Double-click shows only that type ("1 of 20 shown")', async () => {
      await rows.nth(2).dblclick();
    }, 900);
    await step(page, 'legend', 'click-another', 'Clicking another hidden row adds it ("2 of 20 shown")', async () => {
      await rows.nth(4).click();
    }, 900);
    await step(page, 'legend', 'select-under-filter', 'A box selection only contains the visible types (summary composition lists only them)', async () => {
      await page.getByRole('button', { name: 'Box', exact: true }).click();
      await drag(page, [20, 20], [1000, 800]);
      await page.waitForSelector('.summary-head', { timeout: 20_000 });
    }, 1000);
    await step(page, 'legend', 'colour-by-tissue-keeps-filter', 'Colouring by tissue keeps the cell-type filter, shown as a chip; tissue counts count only visible cells', async () => {
      await page.locator('.colorby select').selectOption('c:tissue');
    }, 1000);
    await step(page, 'legend', 'clear-chip', 'Removing the chip shows every cell again and the selection regains its hidden cells', async () => {
      await page.locator('.filter-chip button').click();
    }, 1000);
    await step(page, 'legend', 'search', 'Typing in the search box narrows the rows', async () => {
      await page.locator('.colorby select').selectOption('c:cell_type');
      await page.locator('.legend-search').fill('cell');
    }, 600);
    await step(page, 'legend', 'hide-all-show-all', 'Hide all empties the plot; Show all restores it', async () => {
      await page.locator('.legend-search').fill('');
      await page.getByRole('button', { name: 'Hide all' }).click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${OUT}/${String(stepNo + 1).padStart(3, '0')}-legend-hide-all-intermediate.png` });
      await page.getByRole('button', { name: 'Show all' }).click();
    }, 900);
    await page.close();
  },

  async trajectory(browser) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await load(page, '/?dataset=traj500k', '500,000 cells');
    await step(page, 'trajectory', 'open', 'Trajectory: cells coloured by pseudotime, principal graph with every node drawn, root/branch/leaf markers', async () => {}, 300);
    const click = async n => {
      const pos = await page.evaluate(i => window.__cellViewer.view.nodeScreenPosition(i), n);
      const b = await canvasBox(page);
      await page.mouse.click(b.x + pos[0], b.y + pos[1]);
    };
    await step(page, 'trajectory', 'click-node', 'Clicking node 40 highlights its 5 closest nodes along the trajectory, numbered, with a node card', async () => click(40), 1000);
    await step(page, 'trajectory', 'k-10', 'Raising "Closest nodes" to 10 highlights ten', async () => {
      await page.locator('[data-k]').fill('10');
      await page.locator('[data-k]').dispatchEvent('input');
    }, 900);
    await step(page, 'trajectory', 'euclidean', '"in embedding" switches to straight-line neighbours with connector lines', async () => {
      await page.locator('input[name="traj-metric"][value="euclidean"]').check();
    }, 900);
    await step(page, 'trajectory', 'click-leaf', 'Clicking another node moves the highlight there', async () => click(5), 1000);
    await step(page, 'trajectory', 'click-empty', 'Clicking empty space clears the node highlight', async () => {
      const b = await canvasBox(page);
      await page.mouse.click(b.x + 20, b.y + 20);
    }, 900);
    await step(page, 'trajectory', 'labels', 'Label root and branches adds labels', async () => {
      await page.locator('.graph-controls input[data-labels]').check();
    }, 900);
    await step(page, 'trajectory', 'hide-graph', 'Show trajectory off hides the graph; cells stay', async () => {
      await page.locator('.graph-controls input[data-graph]').uncheck();
    }, 900);
    await step(page, 'trajectory', 'white-theme', 'On white, the graph, markers and highlight stay legible', async () => {
      await page.locator('.graph-controls input[data-graph]').check();
      await page.locator('.theme-picker button', { hasText: 'White' }).click();
      await click(40);
    }, 1000);
    await page.close();
  },

  async inset(browser) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await load(page, '/?dataset=sim1m', '1,000,000 cells');
    await step(page, 'inset', 'open-zoom', 'Inset opens: magnified region, dashed marker on the plot, two connector lines, magnification shown', async () => {
      await page.getByRole('button', { name: 'Inset', exact: true }).click();
    }, 1400);
    await step(page, 'inset', 'move-marker', 'Dragging the marker grip moves the region; inset content follows', async () => {
      const g = await page.locator('.inset-marker .grip').boundingBox();
      await page.mouse.move(g.x + 10, g.y + 6);
      await page.mouse.down();
      await page.mouse.move(g.x - 150, g.y + 140, { steps: 6 });
      await page.mouse.up();
    }, 1200);
    await step(page, 'inset', 'resize-marker', 'Dragging the marker corner enlarges the region; magnification drops', async () => {
      const c = await page.locator('.inset-marker .corner').boundingBox();
      await page.mouse.move(c.x + 5, c.y + 5);
      await page.mouse.down();
      await page.mouse.move(c.x + 80, c.y + 60, { steps: 5 });
      await page.mouse.up();
    }, 1200);
    await step(page, 'inset', 'drag-frame', 'Dragging the inset header moves the panel; connectors follow', async () => {
      const h = await page.locator('.inset-frame header .title').boundingBox();
      await page.mouse.move(h.x + 5, h.y + 5);
      await page.mouse.down();
      await page.mouse.move(h.x - 500, h.y + 400, { steps: 6 });
      await page.mouse.up();
    }, 1200);
    await step(page, 'inset', 'resize-frame', 'Dragging the corner grip resizes the panel', async () => {
      const r = await page.locator('.inset-resize').boundingBox();
      await page.mouse.move(r.x + 7, r.y + 7);
      await page.mouse.down();
      await page.mouse.move(r.x + 120, r.y + 60, { steps: 5 });
      await page.mouse.up();
    }, 1200);
    await step(page, 'inset', 'pan-main', 'Panning the main view keeps marker and connectors locked to the data', async () => {
      await drag(page, [600, 200], [700, 260]);
    }, 1200);
    await step(page, 'inset', 'overview', 'Overview shows the whole dataset with the main viewport outlined', async () => {
      await page.locator('.inset-frame [data-mode="overview"]').click();
    }, 1200);
    await step(page, 'inset', 'overview-click', 'Clicking in the overview recentres the main view; the outline moves', async () => {
      const body = await page.locator('.inset-body').boundingBox();
      await page.mouse.click(body.x + body.width * 0.25, body.y + body.height * 0.3);
    }, 1200);
    await step(page, 'inset', 'anatomy', 'Anatomy mode shows the organ figure inside the inset', async () => {
      await page.locator('.inset-frame [data-mode="anatomy"]').click();
    }, 1000);
    await step(page, 'inset', 'grey-theme', 'On grey, the inset frame and its content follow the theme', async () => {
      await page.locator('.inset-frame [data-mode="zoom"]').click();
      await page.locator('.theme-picker button', { hasText: 'Grey' }).click();
    }, 1200);
    await step(page, 'inset', 'close', 'Close hides the panel, the marker and the connectors', async () => {
      await page.locator('.inset-frame .close').click();
    }, 800);
    await page.close();
  },

  async anatomy(browser) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await load(page, '/?dataset=atlas300k', '300,000 cells');
    await step(page, 'anatomy', 'body', 'Atlas opens; body figure shaded by tissue share; status line says how many cells map', async () => {}, 300);
    await step(page, 'anatomy', 'click-liver', 'Clicking the liver selects exactly the liver cells (summary tissue = liver only)', async () => {
      await page.locator('.anatomy svg .seg[data-seg="liver"]').click();
    }, 1200);
    await step(page, 'anatomy', 'shift-heart', 'Shift-click on the heart adds the heart cells', async () => {
      await page.locator('.anatomy svg .seg[data-seg="heart"]').click({ modifiers: ['Shift'] });
    }, 1200);
    await step(page, 'anatomy', 'drill-heart', 'Double-clicking the heart opens the heart figure (breadcrumb Whole body › Heart)', async () => {
      await page.locator('.anatomy svg .seg[data-seg="heart"]').dblclick();
    }, 1200);
    await step(page, 'anatomy', 'click-lv', 'Clicking the left ventricle selects its cells; summary tissue = heart', async () => {
      await page.locator('.anatomy svg .seg[data-seg="left_ventricle"]').click();
    }, 1200);
    await step(page, 'anatomy', 'brain-tab', 'Brain tab: lobes plus dashed deep structures, shaded', async () => {
      await page.locator('.anatomy-tabs button', { hasText: 'Brain' }).click();
    }, 900);
    await step(page, 'anatomy', 'liver-tab', 'Liver tab', async () => {
      await page.locator('.anatomy-tabs button', { hasText: 'Liver' }).click();
    }, 900);
    await step(page, 'anatomy', 'pancreas-tab', 'Pancreas tab', async () => {
      await page.locator('.anatomy-tabs button', { hasText: 'Pancreas' }).click();
    }, 900);
    await step(page, 'anatomy', 'lasso-reshades', 'A box on the plot re-shades the body figure by where the selected cells come from', async () => {
      await page.locator('.anatomy-tabs button', { hasText: 'Whole body' }).click();
      await page.getByRole('button', { name: 'Box', exact: true }).click();
      await drag(page, [100, 100], [500, 500]);
    }, 1500);
    await step(page, 'anatomy', 'field-override', 'Region field override to anatomical_region re-maps the body figure', async () => {
      await page.locator('.field-select select').selectOption('anatomical_region');
    }, 900);
    await step(page, 'anatomy', 'yellow-theme', 'On light yellow, shading and outlines remain visible', async () => {
      await page.locator('.field-select select').selectOption('');
      await page.locator('.theme-picker button', { hasText: 'Light yellow' }).click();
    }, 1000);
    await page.close();
  },

  async small(browser) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 680 } });
    await load(page, '/?dataset=sim100k', '100,000 cells');
    await step(page, 'small', 'layout-1024', 'At 1024x680 nothing overlaps or overflows horizontally; the side panel scrolls', async () => {}, 300);
    await step(page, 'small', 'inset-1024', 'The inset fits inside the smaller plot', async () => {
      await page.getByRole('button', { name: 'Inset', exact: true }).click();
    }, 1200);
    await page.close();
  },

  async pages(browser) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1400 } });
    await step(page, 'pages', 'gallery', 'Organ gallery renders all five organs, one colour per segment', async () => {
      await page.goto(`${WEB}/anatomy.html`);
      await page.waitForSelector('body[data-ready="1"]');
    }, 500);
    await step(page, 'pages', 'bench', 'Capacity sweep page renders its controls and lists available datasets', async () => {
      await page.goto(`${WEB}/bench.html`);
    }, 1500);
    await step(page, 'pages', 'diag', 'Render diagnostics page renders its controls', async () => {
      await page.goto(`${WEB}/diag.html`);
    }, 1000);
    await step(page, 'pages', 'bad-dataset', '?dataset=nope reports the unknown dataset instead of silently opening another', async () => {
      await page.goto(`${WEB}/?dataset=nope`);
      await page.waitForTimeout(4000);
    }, 500);
    await page.close();
  }
};

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  await ensureServer(`${API}/api/datasets`, '.venv/bin/python', ['-m', 'uvicorn', 'server.main:app', '--port', '8000', '--log-level', 'warning']);
  await ensureServer(WEB, 'npx', ['vite']);
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
  try {
    for (const [name, run] of Object.entries(tours)) {
      if (only && only !== name) continue;
      try {
        await run(browser);
      } catch (err) {
        report.push({ tour: name, fatal: err instanceof Error ? err.message.split('\n')[0] : String(err) });
        console.error(`[${name}] ${err instanceof Error ? err.message.split('\n')[0] : err}`);
      }
    }
  } finally {
    await browser.close();
    writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
    console.log(`${OUT}/report.json`);
  }
}

main().then(() => process.exit(0), err => {
  console.error(err);
  process.exit(1);
});
