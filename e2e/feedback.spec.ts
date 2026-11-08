import { expect, test, type Page } from '@playwright/test';

/**
 * Feedback round, one block per item.
 * Interaction runs on the 100k dataset for the same reason as viewer.spec.ts:
 * headless WebGL is software-rendered, and these tests check behaviour.
 */
const SMALL = '/?dataset=sim100k';

/** Waits for the final status line, not a progress line mid-load. */
async function waitForLoad(page: Page, expected: string): Promise<void> {
  await expect(page.locator('#status')).toHaveText(new RegExp(`${expected} cells$`), { timeout: 90_000 });
}

async function canvasBox(page: Page) {
  // boundingBox() answers null rather than waiting while the canvas is not
  // laid out yet, so wait for it first.
  const canvas = page.locator('.canvas-holder canvas').first();
  await expect(canvas).toBeVisible();
  return (await canvas.boundingBox())!;
}

async function boxSelect(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.getByRole('button', { name: 'Box', exact: true }).click();
  const box = await canvasBox(page);
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(box.x + from[0] + ((to[0] - from[0]) * i) / 4, box.y + from[1] + ((to[1] - from[1]) * i) / 4);
  }
  await page.mouse.up();
}

test.describe('UI-2 background colour', () => {
  test('offers exactly black, white, grey and light yellow, and applies one everywhere', async ({ page }) => {
    await page.goto(SMALL);
    await waitForLoad(page, '100,000');
    const picker = page.locator('.theme-picker button');
    await expect(picker).toHaveText(['Black', 'White', 'Grey', 'Light yellow']);

    for (const [name, id, bg] of [
      ['White', 'white', 'rgb(255, 255, 255)'],
      ['Grey', 'grey', 'rgb(235, 235, 235)'],
      ['Light yellow', 'yellow', 'rgb(253, 246, 227)'],
      ['Black', 'black', 'rgb(0, 0, 0)']
    ] as const) {
      await page.locator('.theme-picker button', { hasText: name }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', id);
      await expect(page.locator('.canvas-holder')).toHaveCSS('background-color', bg);
    }
  });

  test('keeps the selection and survives a reload', async ({ page }) => {
    await page.goto(SMALL);
    await waitForLoad(page, '100,000');
    await boxSelect(page, [150, 120], [500, 460]);
    await expect(page.locator('.chat-badge')).toContainText('cells');
    const badge = await page.locator('.chat-badge').textContent();
    await page.locator('.theme-picker button', { hasText: 'White' }).click();
    await expect(page.locator('.chat-badge')).toHaveText(badge!);

    await page.reload();
    await waitForLoad(page, '100,000');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'white');
  });
});

test.describe('UI-3 Plotly-style legend filter', () => {
  test('click hides a cell type, double-click isolates, double-click again restores', async ({ page }) => {
    await page.goto(SMALL);
    await waitForLoad(page, '100,000');
    const count = page.locator('.legend-count');
    await expect(count).toHaveText('20 of 20 shown');
    const first = page.locator('.legend-row').first();

    await first.click();
    await expect(first).toHaveAttribute('aria-pressed', 'false');
    await expect(count).toHaveText('19 of 20 shown');
    await first.click();
    await expect(count).toHaveText('20 of 20 shown');

    await first.dblclick();
    await expect(count).toHaveText('1 of 20 shown');
    await first.dblclick();
    await expect(count).toHaveText('20 of 20 shown');
  });

  test('a selection only contains visible cell types, and the filter outlives a colour-by change', async ({ page }) => {
    await page.goto(SMALL);
    await waitForLoad(page, '100,000');
    const first = page.locator('.legend-row').first();
    const label = (await first.locator('span').textContent())!;
    // "only" sits beside the row and appears on hover or focus.
    const item = page.locator('.legend-item').first();
    await item.hover();
    await item.locator('[data-only]').click();
    await expect(page.locator('.legend-count')).toHaveText('1 of 20 shown');

    await boxSelect(page, [10, 10], [1000, 820]);
    await expect(page.locator('.summary-head')).toContainText('cells selected');
    const typeRows = page.locator('.sum-block').first().locator('.sum-row');
    await expect(typeRows).toHaveCount(1);
    await expect(typeRows.first()).toContainText(label);

    await page.locator('.colorby select').selectOption('c:tissue');
    await expect(page.locator('.filter-chip')).toContainText('cell_type: 19 hidden');
    await page.locator('.filter-chip button').click();
    await expect(page.locator('.filter-chip')).toHaveCount(0);
    // Relaxing the filter restores the hidden part of the selection.
    await expect(page.locator('.sum-block').first().locator('.sum-row')).not.toHaveCount(1);
  });

  test('lists every level and searches them', async ({ page }) => {
    await page.goto(SMALL);
    await waitForLoad(page, '100,000');
    await expect(page.locator('.legend-row')).toHaveCount(20);
    await page.locator('.legend-search').fill('cell');
    const rows = await page.locator('.legend-row span').allTextContents();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.toLowerCase()).toContain('cell');
  });
});

test.describe('UI-4 trajectory node neighbourhood', () => {
  test('clicking a node highlights and lists its k closest nodes', async ({ page }) => {
    test.slow();
    await page.goto('/?dataset=traj500k');
    await waitForLoad(page, '500,000');
    const pos = await page.evaluate(
      () => (window as unknown as { __cellViewer: { view: { nodeScreenPosition(n: number): [number, number] } } })
        .__cellViewer.view.nodeScreenPosition(40)
    );
    const box = await canvasBox(page);
    await page.mouse.click(box.x + pos[0], box.y + pos[1]);

    const card = page.locator('.node-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('node 40');
    await expect(card.locator('ol li')).toHaveCount(5);

    await page.locator('[data-k]').fill('8');
    await page.locator('[data-k]').dispatchEvent('input');
    await expect(card.locator('ol li')).toHaveCount(8);
    // The rank numbers sit around nodes a few pixels apart at this zoom: the
    // closest rank is always drawn and no two drawn numbers overlap. The boxes
    // come from the layer's own accessors, as deck.gl draws them.
    const rankChips = (layerId: string) =>
      page.evaluate(id => {
        type Accessor<T> = T | ((d: unknown) => T);
        type TextProps = {
          data: unknown[];
          getText: Accessor<string>;
          getPosition: Accessor<[number, number]>;
          getPixelOffset: Accessor<[number, number]>;
          getSize: number;
          backgroundPadding: [number, number];
        };
        const view = (window as unknown as {
          __cellViewer: { view: { canvas: { deck: { props: { layers: { id: string; props: TextProps }[] } }; worldToScreen(x: number, y: number): [number, number] } } };
        }).__cellViewer.view;
        const layer = view.canvas.deck.props.layers.find(l => l.id === id);
        if (!layer) return null;
        const p = layer.props;
        const read = <T,>(a: Accessor<T>, d: unknown): T => (typeof a === 'function' ? (a as (d: unknown) => T)(d) : a);
        return p.data.map(d => {
          const text = read(p.getText, d);
          const [wx, wy] = read(p.getPosition, d);
          const [x, y] = view.canvas.worldToScreen(wx, wy);
          const [dx, dy] = read(p.getPixelOffset, d);
          // Monospace glyphs are 0.6 em wide; the chip adds its padding.
          const w = text.length * 0.6 * p.getSize + 2 * p.backgroundPadding[0];
          const h = p.getSize + 2 * p.backgroundPadding[1];
          return { rank: Number(text), dx, dy, x0: x + dx - w / 2, x1: x + dx + w / 2, y0: y + dy - h / 2, y1: y + dy + h / 2 };
        });
      }, layerId);
    const chips = (await rankChips('hl-ranks'))!;
    expect(chips.map(c => c.rank)).toContain(1);
    // The scene is crowded enough to need the layout: some rank is moved off
    // the default up-right corner or left out.
    const moved = chips.filter(c => c.dx < 0 || c.dy > 0).length + (8 - chips.length);
    expect(moved).toBeGreaterThan(0);
    for (const a of chips) {
      for (const b of chips) {
        if (a.rank < b.rank) {
          const apart = a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0;
          expect(apart, `rank ${a.rank} and rank ${b.rank} overlap`).toBe(true);
        }
      }
    }
    // The magnified inset lays out its own numbers; there are none before it opens.
    expect(await rankChips('inset:hl-ranks')).toBeNull();
    await page.getByRole('button', { name: 'Inset', exact: true }).click();
    await expect.poll(async () => (await rankChips('inset:hl-ranks'))?.map(c => c.rank) ?? []).toContain(1);
    await page.getByRole('button', { name: 'Inset', exact: true }).click();
    await expect.poll(() => rankChips('inset:hl-ranks')).toBeNull();
    await page.locator('input[name="traj-metric"][value="euclidean"]').check();
    await expect(card).toContainText('in embedding');

    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
  });

  test('a click within 10 px of a small node selects it; farther away falls through (D1)', async ({ page }) => {
    test.slow();
    await page.goto('/?dataset=traj500k');
    await waitForLoad(page, '500,000');
    const box = await canvasBox(page);
    // Zoom in so nodes spread apart; at the default zoom they sit closer
    // together than the hit radius.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(600);
    // An internal node (degree 2, drawn 2.4 px wide), and a direction in which
    // a point 8 px away is nearer to it than to any other node by a margin, and
    // a point 16 px away is beyond every node's reach.
    const found = await page.evaluate(([w, h]) => {
      const view = (window as unknown as {
        __cellViewer: { view: { graph: { nodes: [number, number][]; edges: [number, number][] }; nodeScreenPosition(n: number): [number, number] } };
      }).__cellViewer.view;
      const degree = new Array(view.graph.nodes.length).fill(0);
      for (const [a, b] of view.graph.edges) { degree[a]++; degree[b]++; }
      const pos = view.graph.nodes.map((_, n) => view.nodeScreenPosition(n));
      const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (let n = 0; n < pos.length; n++) {
        if (degree[n] !== 2) continue;
        const [x, y] = pos[n];
        if (x < 40 || y < 40 || x > w - 40 || y > h - 40) continue;
        for (const [dx, dy] of dirs) {
          const near = [x + 8 * dx, y + 8 * dy];
          const far = [x + 16 * dx, y + 16 * dy];
          const ok = pos.every(([ox, oy], m) =>
            (m === n || Math.hypot(ox - near[0], oy - near[1]) > 12) && Math.hypot(ox - far[0], oy - far[1]) > 13
          );
          if (ok) return { n, near, far };
        }
      }
      return null;
    }, [box.width, box.height]);
    expect(found).not.toBeNull();
    const { n, near, far } = found!;
    const card = page.locator('.node-card');

    await page.mouse.click(box.x + near[0], box.y + near[1]);
    await expect(card).toBeVisible();
    await expect(card).toContainText(`node ${n}`);
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();

    await page.mouse.click(box.x + far[0], box.y + far[1]);
    await page.waitForTimeout(800);
    await expect(card).toBeHidden();
  });
});

test.describe('UI-5 foreground inset', () => {
  test('opens a zoom inset with a marked region and two connectors, then overview and anatomy', async ({ page }) => {
    await page.goto(SMALL);
    await waitForLoad(page, '100,000');
    const frame = page.locator('.inset-frame');
    await expect(frame).toBeHidden();
    await page.getByRole('button', { name: 'Inset', exact: true }).click();
    await expect(frame).toBeVisible();
    await expect(page.locator('.inset-marker')).toBeVisible();
    await expect(page.locator('.inset-connectors')).toBeVisible();
    await expect(page.locator('.inset-connectors line')).toHaveCount(2);
    await expect(frame.locator('.mag')).toContainText('×');

    // The magnified picture must actually differ from an empty panel.
    const body = frame.locator('.inset-body');
    const shot1 = await body.screenshot();
    await page.locator('.inset-marker .grip').hover();
    await page.mouse.down();
    await page.mouse.move(400, 300, { steps: 4 });
    await page.mouse.up();
    const shot2 = await body.screenshot();
    expect(Buffer.compare(shot1, shot2)).not.toBe(0);

    await frame.locator('[data-mode="overview"]').click();
    await expect(page.locator('.inset-viewport')).toBeVisible();
    await expect(page.locator('.inset-marker')).toBeHidden();

    await frame.locator('[data-mode="anatomy"]').click();
    await expect(frame.locator('svg.organ')).toBeVisible();

    await frame.locator('.close').click();
    await expect(frame).toBeHidden();
  });
});

test.describe('NEW segmented anatomy', () => {
  test('clicking a heart chamber selects exactly those cells and drives the summary', async ({ page }) => {
    await page.goto('/?dataset=atlas300k');
    await waitForLoad(page, '300,000');
    await page.locator('.anatomy-tabs button', { hasText: 'Heart' }).click();
    const lv = page.locator('.anatomy svg .seg[data-seg="left_ventricle"]');
    await expect(lv).toBeVisible();
    await lv.click();
    await expect(lv).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.summary-head')).toContainText('cells selected');
    // The summary's tissue block must be all heart.
    const tissue = page.locator('.sum-block').nth(1).locator('.sum-row');
    await expect(tissue).toHaveCount(1);
    await expect(tissue.first()).toContainText('heart');
    await expect(page.locator('.chat-input textarea')).toBeEnabled();
  });

  test('drills from the body into the heart and back, and shades a lasso selection', async ({ page }) => {
    await page.goto('/?dataset=atlas300k');
    await waitForLoad(page, '300,000');
    const heart = page.locator('.anatomy svg .seg[data-seg="heart"]');
    await heart.dblclick();
    await expect(page.locator('.anatomy-crumbs')).toContainText('Heart');
    await page.locator('.anatomy-crumbs button').click();
    await expect(page.locator('.anatomy svg .seg[data-seg="heart"]')).toBeVisible();

    await boxSelect(page, [100, 100], [500, 500]);
    await expect(page.locator('.anatomy-actions')).toContainText('selected cells map to');
  });

  test('ships body, heart, brain, liver and pancreas figures', async ({ page }) => {
    await page.goto('/?dataset=atlas300k');
    await waitForLoad(page, '300,000');
    // The five the client asked for, first and in order; a sixth organ
    // appended to the registry must not need this test edited (F5).
    const tabs = await page.locator('.anatomy-tabs button').allTextContents();
    expect(tabs.slice(0, 5)).toEqual(['Whole body', 'Heart', 'Brain', 'Liver', 'Pancreas']);
  });
});

test('no console errors while exercising every feedback feature', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));
  await page.goto(SMALL);
  await waitForLoad(page, '100,000');
  await page.locator('.theme-picker button', { hasText: 'Grey' }).click();
  await page.locator('.legend-row').first().click();
  await page.getByRole('button', { name: 'Inset', exact: true }).click();
  await page.locator('.inset-frame [data-mode="overview"]').click();
  await page.locator('.inset-frame [data-mode="anatomy"]').click();
  const box = await canvasBox(page);
  await page.mouse.click(box.x + box.width / 3, box.y + box.height / 2);
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});

/**
 * Regressions found by the second review round and the browser walkthrough.
 * Each pins a defect that a user actually hit.
 */
test.describe('review round 2 regressions', () => {
  test('reset view restores the zoom after a mouse-wheel zoom', async ({ page }) => {
    await page.goto(SMALL);
    await waitForLoad(page, '100,000');
    await page.waitForTimeout(800);
    const zoom = () =>
      page.evaluate(() => (window as unknown as { __cellViewer: { view: { canvas: { viewState: { zoom: number } } } } }).__cellViewer.view.canvas.viewState.zoom);
    const before = await zoom();
    const box = await canvasBox(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -600);
    await expect.poll(zoom).toBeGreaterThan(before + 0.5);
    await page.getByRole('button', { name: 'Reset view' }).click();
    // deck.gl 9 keeps zoomX/zoomY after a wheel zoom; a reset that only set
    // `zoom` used to pan without zooming back out.
    await expect.poll(async () => {
      const vs = await page.evaluate(() => {
        const c = (window as unknown as { __cellViewer: { view: { canvas: { deck: { getViewports(): { zoom: number }[] } } } } }).__cellViewer.view.canvas;
        return c.deck.getViewports()[0].zoom;
      });
      return vs;
    }, { timeout: 5000 }).toBeLessThan(before);
  });

  test('a jittery click in Box mode keeps the selection and opens the card', async ({ page }) => {
    await page.goto(SMALL);
    await waitForLoad(page, '100,000');
    await boxSelect(page, [150, 120], [600, 520]);
    await expect(page.locator('.summary-head')).toContainText('cells selected');
    const head = await page.locator('.summary-head').textContent();
    const box = await canvasBox(page);
    const card = page.locator('.cell-card');
    // Press, wobble 3 px, release: a click, not a drag. Probe until one lands
    // on a cell, so the test proves the card opens rather than assuming it.
    let opened = false;
    for (let i = 0; i < 30 && !opened; i++) {
      const x = box.x + box.width * (0.35 + (i % 6) * 0.06);
      const y = box.y + box.height * (0.35 + Math.floor(i / 6) * 0.06);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 3, y + 2);
      await page.mouse.up();
      opened = await card.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false);
      await expect(page.locator('.summary-head')).toHaveText(head!);
    }
    expect(opened, 'a jittery click on a cell opens its card').toBe(true);
  });

  test('the cell card closes with × and with a click on empty space', async ({ page }) => {
    await page.goto(SMALL);
    await waitForLoad(page, '100,000');
    const card = page.locator('.cell-card');
    const box = await canvasBox(page);
    const openCard = async () => {
      for (let i = 0; i < 30; i++) {
        await page.mouse.click(box.x + box.width * (0.35 + (i % 6) * 0.06), box.y + box.height * (0.35 + Math.floor(i / 6) * 0.06));
        if (await card.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) return;
      }
      throw new Error('no cell under any probe point');
    };
    await openCard();
    await expect(card).toContainText('position');
    await card.locator('.close').click();
    await expect(card).toBeHidden();
    await openCard();
    await page.mouse.click(box.x + 4, box.y + 4); // a corner with no cells
    await expect(card).toBeHidden();
  });

  test('hidden cells are never picked', async ({ page }) => {
    await page.goto(SMALL);
    await waitForLoad(page, '100,000');
    await page.getByRole('button', { name: 'Hide all' }).click();
    await expect(page.locator('.legend-count')).toHaveText('0 of 20 shown');
    const box = await canvasBox(page);
    for (let i = 0; i < 6; i++) {
      await page.mouse.click(box.x + box.width * (0.35 + i * 0.06), box.y + box.height * 0.5);
      await page.waitForTimeout(400);
    }
    await expect(page.locator('.cell-card')).toBeHidden();
  });

  test('a long legend lists every level (atlas cell types, more than 20)', async ({ page }) => {
    await page.goto('/?dataset=atlas300k');
    await waitForLoad(page, '300,000');
    const n = await page.locator('.legend-row').count();
    expect(n).toBeGreaterThan(20);
    await expect(page.locator('.legend-count')).toHaveText(`${n} of ${n} shown`);
  });

  test('double-clicking an organ to open it keeps a lasso selection', async ({ page }) => {
    await page.goto('/?dataset=atlas300k');
    await waitForLoad(page, '300,000');
    await boxSelect(page, [100, 100], [700, 600]);
    await expect(page.locator('.summary-head')).toContainText('cells selected');
    const head = await page.locator('.summary-head').textContent();
    await page.locator('.anatomy svg .seg[data-seg="heart"]').dblclick();
    await expect(page.locator('.anatomy-crumbs')).toContainText('Heart');
    await expect(page.locator('.summary-head')).toHaveText(head!);
  });

  test('liver lobes and the pancreas head select their cells', async ({ page }) => {
    await page.goto('/?dataset=atlas300k');
    await waitForLoad(page, '300,000');
    for (const [tab, seg, tissue] of [
      ['Liver', 'right_lobe', 'liver'],
      ['Pancreas', 'head', 'pancreas']
    ] as const) {
      await page.locator('.anatomy-tabs button', { hasText: tab }).click();
      await page.locator(`.anatomy svg .seg[data-seg="${seg}"]`).click();
      await expect(page.locator('.summary-head')).toContainText('cells selected');
      const rows = page.locator('.sum-block').nth(1).locator('.sum-row');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText(tissue);
    }
  });

  test('"Show in plot" opens the same organ in the inset', async ({ page }) => {
    await page.goto('/?dataset=atlas300k');
    await waitForLoad(page, '300,000');
    await page.locator('.anatomy-tabs button', { hasText: 'Brain' }).click();
    await page.getByRole('button', { name: 'Show in plot' }).click();
    await expect(page.locator('.inset-frame .anatomy-crumbs')).toContainText('Brain');
  });

  test('the inset frame drags, the overview recentres the plot, and there is one canvas', async ({ page }) => {
    await page.goto(SMALL);
    await waitForLoad(page, '100,000');
    await page.getByRole('button', { name: 'Inset', exact: true }).click();
    const frame = page.locator('.inset-frame');
    const before = (await frame.boundingBox())!;
    const title = (await frame.locator('header .title').boundingBox())!;
    await page.mouse.move(title.x + 4, title.y + 4);
    await page.mouse.down();
    await page.mouse.move(title.x - 300, title.y + 200, { steps: 4 });
    await page.mouse.up();
    const after = (await frame.boundingBox())!;
    expect(after.x).toBeLessThan(before.x - 200);
    await expect(page.locator('canvas')).toHaveCount(1);

    await frame.locator('[data-mode="overview"]').click();
    const target = () =>
      page.evaluate(() => (window as unknown as { __cellViewer: { view: { canvas: { viewState: { target: number[] } } } } }).__cellViewer.view.canvas.viewState.target[0]);
    const t0 = await target();
    const body = (await frame.locator('.inset-body').boundingBox())!;
    await page.mouse.click(body.x + body.width * 0.15, body.y + body.height * 0.5);
    await expect.poll(target).not.toBeCloseTo(t0, 1);
  });

  test('image mode shows a chosen picture in the foreground panel', async ({ page }) => {
    await page.goto(SMALL);
    await waitForLoad(page, '100,000');
    await page.getByRole('button', { name: 'Inset', exact: true }).click();
    await page.locator('.inset-frame [data-mode="image"]').click();
    // A 1x1 PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    await page.locator('.inset-image input[type=file]').setInputFiles({ name: 'tissue.png', mimeType: 'image/png', buffer: png });
    await expect(page.locator('.inset-image img')).toBeVisible();
  });

  test('the plot appears before the last chunk has arrived', async ({ page }) => {
    // Slow every chunk after the first so the load is observably progressive.
    await page.route(/\/chunk\/.*\/[1-9]\d*(\?.*)?$/, async route => {
      await new Promise(r => setTimeout(r, 1500));
      await route.continue();
    });
    await page.goto('/?dataset=sim1m');
    await expect(page.locator('.canvas-holder canvas')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#status')).toContainText('chunks');
    await waitForLoad(page, '1,000,000');
  });

  test('an unknown ?dataset= is reported, not silently replaced', async ({ page }) => {
    await page.goto('/?dataset=nope');
    await expect(page.locator('#status')).toContainText('No dataset named "nope"', { timeout: 90_000 });
    await expect(page.locator('#status')).toHaveText(/cells$/, { timeout: 90_000 });
    await expect(page.locator('#status')).toContainText('No dataset named "nope"');
  });
});
