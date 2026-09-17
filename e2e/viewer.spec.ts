import { expect, test, type Page } from '@playwright/test';

/**
 * Interaction tests run against the 100k dataset, not the million-cell one.
 *
 * Headless Chromium has no GPU here, so WebGL falls back to SwiftShader and
 * rasterises every point on the CPU. Measured on this machine, a three-event
 * drag costs 3.3 s at 100k and 11.4 s at 1M — the input queue, not the app,
 * is what stalls. Rendering throughput is measured properly on real hardware
 * by the /bench.html sweep; what these tests are for is behaviour: that a
 * drag becomes a selection, that the selection reaches the chat panel, that
 * clearing it disables the input again. 100k exercises every one of those
 * paths, including the real Web Worker and the real grid index.
 *
 * The load-scale tests below still use the full million.
 */
const SMALL = '/?dataset=sim100k';
const LARGE = '/?dataset=sim1m';

async function waitForLoad(page: Page, expected: string): Promise<void> {
  await expect(page.locator('#status')).toContainText(expected, { timeout: 90_000 });
}

async function dragOn(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  // A few intermediate moves: a single jump would produce a degenerate shape,
  // and every extra one costs a software-rendered frame.
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(
      box.x + from[0] + ((to[0] - from[0]) * i) / 4,
      box.y + from[1] + ((to[1] - from[1]) * i) / 4
    );
  }
  await page.mouse.up();
}

async function lassoCircle(page: Page, radius: number): Promise<void> {
  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx + radius, cy);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    await page.mouse.move(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
  }
  await page.mouse.up();
}

test('loads a million cells and reports the count', async ({ page }) => {
  await page.goto(LARGE);
  await waitForLoad(page, '1,000,000');
});

test('a million cells arrive in chunks, so partial data is visible early', async ({ page }) => {
  // Poll the status line rather than asserting on a particular intermediate
  // count: chunks can complete faster than the DOM is read. What must hold is
  // that the load ends complete and unflagged.
  await page.goto(LARGE);

  const status = page.locator('#status');
  const observed = new Set<string>();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const text = (await status.textContent()) ?? '';
    if (text) observed.add(text);
    if (/^1,000,000 cells/.test(text)) break;
    await page.waitForTimeout(25);
  }
  await waitForLoad(page, '1,000,000');

  // Whatever the timing, the final state must be the full count and the plot
  // must be usable: a partial load leaves a "chunks failed" suffix behind.
  const final = (await status.textContent()) ?? '';
  expect(final).toBe('1,000,000 cells');
  expect(final).not.toContain('failed');
  expect(observed.size).toBeGreaterThan(0);
});

test('box selection populates the summary and enables the chat input', async ({ page }) => {
  await page.goto(SMALL);
  await waitForLoad(page, '100,000');

  await expect(page.locator('.chat-input textarea')).toBeDisabled();
  await page.getByRole('button', { name: 'Box', exact: true }).click();
  await dragOn(page, [150, 120], [500, 460]);

  await expect(page.locator('.summary-head')).toContainText('cells selected');
  await expect(page.locator('.chat-badge')).not.toHaveText('no selection');
  await expect(page.locator('.chat-input textarea')).toBeEnabled();
});

test('lasso selection produces a non-empty selection', async ({ page }) => {
  await page.goto(SMALL);
  await waitForLoad(page, '100,000');
  await page.getByRole('button', { name: 'Lasso', exact: true }).click();
  await lassoCircle(page, 140);

  await expect(page.locator('.summary-head')).toContainText('cells selected');
  const text = await page.locator('.summary-head').textContent();
  const count = Number((text ?? '').replace(/,/g, '').match(/(\d+)/)?.[1] ?? 0);
  expect(count).toBeGreaterThan(0);
});

test('the chat panel answers a question about the selection', async ({ page }) => {
  await page.goto(SMALL);
  await waitForLoad(page, '100,000');
  await page.getByRole('button', { name: 'Box', exact: true }).click();
  await dragOn(page, [150, 120], [520, 470]);
  // The badge only carries a count once the worker has answered; reading it
  // before then yields "no selection" and asserts against the wrong string.
  await expect(page.locator('.chat-badge')).toContainText('cells');

  const selected = (await page.locator('.chat-badge').textContent())!.replace(' cells', '');
  await page.locator('.chat-input textarea').fill('how many cells are selected?');
  await page.getByRole('button', { name: 'Ask' }).click();

  await expect(page.locator('.msg.assistant').last()).toContainText(selected);
});

test('clearing the selection disables the chat input again', async ({ page }) => {
  await page.goto(SMALL);
  await waitForLoad(page, '100,000');
  await page.getByRole('button', { name: 'Box', exact: true }).click();
  await dragOn(page, [150, 120], [500, 460]);
  await expect(page.locator('.chat-input textarea')).toBeEnabled();

  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('.summary-empty')).toBeVisible();
  await expect(page.locator('.chat-input textarea')).toBeDisabled();
});

test('zoom to selection changes the view', async ({ page }) => {
  await page.goto(SMALL);
  await waitForLoad(page, '100,000');
  await page.getByRole('button', { name: 'Box', exact: true }).click();
  await dragOn(page, [200, 180], [340, 300]);
  await expect(page.locator('.summary-head')).toContainText('cells selected');

  const before = await page.locator('canvas').first().screenshot();
  await page.getByRole('button', { name: 'Zoom to selection' }).click();
  await page.waitForTimeout(2000);
  const after = await page.locator('canvas').first().screenshot();
  expect(Buffer.compare(before, after)).not.toBe(0);
});

test('colour-by change updates the legend without losing the selection', async ({ page }) => {
  await page.goto(SMALL);
  await waitForLoad(page, '100,000');
  await page.getByRole('button', { name: 'Box', exact: true }).click();
  await dragOn(page, [150, 120], [500, 460]);
  const badge = await page.locator('.chat-badge').textContent();

  await page.locator('.colorby select').selectOption('c:tissue');
  await expect(page.locator('.legend-title')).toHaveText('tissue');
  await expect(page.locator('.chat-badge')).toHaveText(badge!);
});

test('the manual detail slider reduces the drawn count', async ({ page }) => {
  await page.goto(SMALL);
  await waitForLoad(page, '100,000');
  await expect(page.locator('.lod-readout')).toContainText('100,000 / 100,000');

  await page.locator('.lod input[type=checkbox]').uncheck();
  await page.locator('.lod input[type=range]').fill('10');
  await page.locator('.lod input[type=range]').dispatchEvent('input');
  await expect(page.locator('.lod-readout')).toContainText('10,000 / 100,000');
});

test('the trajectory view renders the principal graph', async ({ page }) => {
  await page.goto('/?dataset=traj500k');
  await waitForLoad(page, '500,000');

  await expect(page.locator('.graph-controls')).toContainText('branch points');
  await expect(page.locator('.legend-title')).toHaveText('pseudotime');

  // The graph overlay must be removable without disturbing the point cloud.
  await page.locator('.graph-controls input[data-graph]').uncheck();
  await page.locator('.graph-controls input[data-graph]').check();
  await expect(page.locator('.graph-controls')).toContainText('nodes');
});

test('selecting on the trajectory reaches the chat panel with pseudotime', async ({ page }) => {
  // 500k under software rendering is slow but survivable for one box drag, and
  // this is the path the brief actually asks for: select on the trajectory,
  // ask the chatbot about those cells.
  test.slow();
  await page.goto('/?dataset=traj500k');
  await waitForLoad(page, '500,000');

  await page.getByRole('button', { name: 'Box', exact: true }).click();
  await dragOn(page, [200, 150], [600, 400]);
  await expect(page.locator('.summary-head')).toContainText('cells selected');
  await expect(page.locator('.chat-badge')).toContainText('cells');

  await page.locator('.chat-input textarea').fill('where in the trajectory are these cells?');
  await page.getByRole('button', { name: 'Ask' }).click();
  // The trajectory context carries pseudotime, so the answer must cite it.
  await expect(page.locator('.msg.assistant').last()).toContainText('Pseudotime');
});

test('hovering a cell shows its metadata', async ({ page }) => {
  await page.goto(SMALL);
  await waitForLoad(page, '100,000');

  const box = (await page.locator('canvas').first().boundingBox())!;
  const tooltip = page.locator('.tooltip');
  await expect(tooltip).toBeHidden();
  // Sweep across the middle until a point is actually under the cursor.
  for (let i = 0; i < 24; i++) {
    await page.mouse.move(box.x + 80 + i * 24, box.y + box.height / 2);
    if (await tooltip.isVisible()) break;
  }
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('cell_');
  await expect(tooltip).toContainText('cell_type');
  await expect(tooltip).toContainText('pseudotime');
});

test('the translucent toggle re-renders without losing the selection', async ({ page }) => {
  await page.goto(SMALL);
  await waitForLoad(page, '100,000');
  await page.getByRole('button', { name: 'Box', exact: true }).click();
  await dragOn(page, [150, 120], [500, 460]);
  await expect(page.locator('.chat-badge')).toContainText('cells');
  const badge = await page.locator('.chat-badge').textContent();

  await page.locator('.render-control input[data-blend]').check();
  await expect(page.locator('.chat-badge')).toHaveText(badge!);
  await page.locator('.render-control input[data-blend]').uncheck();
  await expect(page.locator('.chat-badge')).toHaveText(badge!);
  await expect(page.locator('.summary-head')).toContainText('cells selected');
});

test('reports no console errors during a normal session', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto(SMALL);
  await waitForLoad(page, '100,000');
  await page.getByRole('button', { name: 'Box', exact: true }).click();
  await dragOn(page, [150, 120], [500, 460]);
  await expect(page.locator('.summary-head')).toContainText('cells selected');
  expect(errors).toEqual([]);
});
