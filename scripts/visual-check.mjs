#!/usr/bin/env node
/**
 * Screenshots every theme and every feedback feature, for a human (or an
 * agent with an image reader) to inspect.
 *
 *   node scripts/visual-check.mjs                 # all groups
 *   node scripts/visual-check.mjs --only anatomy  # one group
 *
 * Reuses servers already listening on :8000 and :5173, otherwise starts them
 * and stops them again on exit. Writes test-results/visual/<group>-<name>.png.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const API = 'http://localhost:8000';
const WEB = 'http://localhost:5173';
const OUT = 'test-results/visual';
const THEMES = ['black', 'white', 'grey', 'yellow'];
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 ? process.argv[i + 1] : null;
})();

const children = [];
async function up(url) {
  try {
    const r = await fetch(url);
    return r.ok || r.status < 500;
  } catch {
    return false;
  }
}
async function ensureServer(url, cmd, args) {
  if (await up(url)) return;
  const child = spawn(cmd, args, { stdio: 'ignore', detached: false });
  children.push(child);
  for (let i = 0; i < 120; i++) {
    if (await up(url)) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`server did not come up: ${url}`);
}
function cleanup() {
  for (const c of children) c.kill();
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

async function waitForLoad(page, text) {
  await page.waitForFunction(
    t => (document.getElementById('status')?.textContent ?? '').endsWith(t),
    text,
    { timeout: 120_000 }
  );
  await page.waitForTimeout(600);
}

async function shot(page, group, name) {
  const path = `${OUT}/${group}-${name}.png`;
  await page.screenshot({ path });
  console.log(path);
}

/** Clicks near the plot centre until the cell card opens. */
async function clickACell(page) {
  const box = await page.locator('.canvas-holder canvas').first().boundingBox();
  for (let i = 0; i < 30; i++) {
    const x = box.x + box.width * (0.35 + (i % 6) * 0.06);
    const y = box.y + box.height * (0.35 + Math.floor(i / 6) * 0.06);
    await page.mouse.click(x, y);
    // The lookup is asynchronous; wait for it before the next click supersedes it.
    if (await page.locator('.cell-card:not([hidden])').waitFor({ timeout: 1200 }).then(() => true, () => false)) return true;
  }
  return false;
}

const groups = {
  async anatomy(browser) {
    for (const theme of THEMES) {
      const page = await browser.newPage({ viewport: { width: 1500, height: 1500 } });
      await page.goto(`${WEB}/anatomy.html?theme=${theme}`);
      await page.waitForSelector('body[data-ready="1"]');
      await shot(page, 'anatomy', `gallery-${theme}`);
      await page.close();
    }
  },

  async themes(browser) {
    for (const theme of THEMES) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${WEB}/?dataset=sim100k&theme=${theme}`);
      await waitForLoad(page, '100,000 cells');
      await page.getByRole('button', { name: 'Box', exact: true }).click();
      const box = await page.locator('.canvas-holder canvas').first().boundingBox();
      await page.mouse.move(box.x + 200, box.y + 160);
      await page.mouse.down();
      await page.mouse.move(box.x + 420, box.y + 380, { steps: 4 });
      await page.mouse.up();
      await page.waitForTimeout(800);
      await shot(page, 'themes', `${theme}-selection`);
      await page.close();
    }
  },

  async card(browser) {
    for (const theme of ['black', 'white']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${WEB}/?dataset=sim100k&theme=${theme}`);
      await waitForLoad(page, '100,000 cells');
      const box = await page.locator('.canvas-holder canvas').first().boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
      await page.waitForTimeout(400);
      await shot(page, 'card', `${theme}-hover-shows-nothing`);
      const clicked = await clickACell(page);
      await shot(page, 'card', `${theme}-clicked${clicked ? '' : '-NOT-CLICKED'}`);
      await page.close();
    }
  },

  async legend(browser) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${WEB}/?dataset=sim100k&theme=white`);
    await waitForLoad(page, '100,000 cells');
    const rows = page.locator('.legend-row');
    await rows.nth(0).dblclick();
    await page.waitForTimeout(900);
    await shot(page, 'legend', 'isolated-first');
    await rows.nth(1).click();
    await page.waitForTimeout(900);
    await shot(page, 'legend', 'two-visible');
    await page.locator('.colorby select').selectOption('c:tissue');
    await page.waitForTimeout(900);
    await shot(page, 'legend', 'filter-kept-colour-by-tissue');
    await page.close();
  },

  async trajectory(browser) {
    for (const theme of ['black', 'yellow']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${WEB}/?dataset=traj500k&theme=${theme}`);
      await waitForLoad(page, '500,000 cells');
      // Click a real node through the UI: the page only reports where it is.
      const pos = await page.evaluate(() => window.__cellViewer?.view?.nodeScreenPosition?.(40));
      const box = await page.locator('.canvas-holder canvas').first().boundingBox();
      if (pos) await page.mouse.click(box.x + pos[0], box.y + pos[1]);
      await page.waitForTimeout(900);
      await shot(page, 'trajectory', `${theme}-node-neighbours${pos ? '' : '-NOT-CLICKED'}`);
      await page.close();
    }
  },

  async inset(browser) {
    for (const theme of ['black', 'grey']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${WEB}/?dataset=sim1m&theme=${theme}`);
      await waitForLoad(page, '1,000,000 cells');
      await page.getByRole('button', { name: 'Inset', exact: true }).click();
      await page.waitForTimeout(1200);
      await shot(page, 'inset', `${theme}-zoom`);
      await page.locator('.inset-frame button[data-mode="overview"]').click();
      await page.waitForTimeout(900);
      await shot(page, 'inset', `${theme}-overview`);
      await page.locator('.inset-frame button[data-mode="anatomy"]').click();
      await page.waitForTimeout(900);
      await shot(page, 'inset', `${theme}-anatomy`);
      await page.close();
    }
  },

  async panel(browser) {
    for (const theme of THEMES) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto(`${WEB}/?dataset=atlas300k&theme=${theme}`);
      await waitForLoad(page, '300,000 cells');
      await page.locator('.anatomy-tabs button', { hasText: 'Heart' }).click();
      await page.waitForTimeout(600);
      await page.locator('.anatomy svg .seg[data-seg="left_ventricle"]').click();
      await page.waitForTimeout(900);
      await shot(page, 'panel', `${theme}-heart-lv-selected`);
      // Switching organ releases the heart region's selection, so the brain
      // figure is shaded by every visible cell, not by an invisible old region.
      await page.locator('.anatomy-tabs button', { hasText: 'Brain' }).click();
      await page.waitForTimeout(700);
      await shot(page, 'panel', `${theme}-brain`);
      await page.close();
    }
  }
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  await ensureServer(`${API}/api/datasets`, '.venv/bin/python', ['-m', 'uvicorn', 'server.main:app', '--port', '8000', '--log-level', 'warning']);
  await ensureServer(WEB, 'npx', ['vite']);
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
  });
  const failed = [];
  try {
    for (const [name, run] of Object.entries(groups)) {
      if (only && only !== name) continue;
      try {
        await run(browser);
      } catch (err) {
        failed.push(name);
        console.error(`[${name}] ${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    await browser.close();
  }
  if (failed.length) {
    console.error(`groups failed: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}

main().then(() => process.exit(process.exitCode ?? 0), err => {
  console.error(err);
  process.exit(1);
});
