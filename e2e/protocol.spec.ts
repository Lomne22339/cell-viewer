import { expect, test, type Page } from '@playwright/test';

/**
 * The differentiation protocol creator: a trajectory map, a pathway graph and
 * a recipe chat that share one state. The data is synthetic and says so.
 *
 * These run against `traj500k`, the trajectory the creator opens by default,
 * with software WebGL, so each test is allowed extra time.
 */
const CREATOR = '/?mode=protocol';

interface Snap {
  clicked: number | null;
  stage: number | null;
  target: number | null;
  traced: number[];
  focus: number | null;
  lineageLeaf: number;
}
interface Creator {
  state: { snapshot(): Snap; click(id: number | null): void };
  tree: { milestones: { id: number; parent: number | null; kind: string; label: string; graphNodes: number[] }[] };
  view: {
    nodeScreenPosition(n: number): [number, number] | null;
    selectionStore: { current: unknown };
    canvas: { size(): { width: number; height: number }; deck: { props: { layers: { id: string }[] } } };
  };
  grid: { expanded(): string | null };
}
declare global {
  interface Window {
    __protocolCreator?: Creator;
  }
}

async function openCreator(page: Page): Promise<void> {
  await page.goto(CREATOR);
  await expect(page.locator('#status')).toHaveText(/synthetic demo data$/, { timeout: 120_000 });
  await expect(page.locator('.pc-map canvas')).toHaveCount(1);
}

const snapshot = (page: Page): Promise<Snap> => page.evaluate(() => window.__protocolCreator!.state.snapshot());

/** A fate, and where its last graph node is on the map. */
async function fate(page: Page, which: number): Promise<{ id: number; pos: [number, number] }> {
  return page.evaluate(k => {
    const c = window.__protocolCreator!;
    const fates = c.tree.milestones.filter(m => m.kind === 'terminal');
    const m = fates[k % fates.length];
    const pos = c.view.nodeScreenPosition(m.graphNodes[m.graphNodes.length - 1])!;
    return { id: m.id, pos };
  }, which);
}

async function clickMap(page: Page, pos: [number, number]): Promise<void> {
  const box = (await page.locator('.pc-map canvas').boundingBox())!;
  await page.mouse.click(box.x + pos[0], box.y + pos[1]);
}

test.describe('protocol creator', () => {
  test('the toggle shows three synthetic panels and returns to the dashboard unchanged', async ({ page }) => {
    test.slow();
    await page.goto('/?dataset=sim100k');
    await expect(page.locator('#status')).toHaveText(/100,000 cells$/, { timeout: 90_000 });
    await expect(page.locator('.chat-head')).toContainText('Ask about the selection');

    await page.getByRole('button', { name: 'Protocol creator' }).click();
    await expect(page.locator('.pg-panel')).toHaveCount(3);
    await expect(page.locator('.pg-panel h2')).toHaveText(['Trajectory map', 'Differentiation pathway', 'Recipe maker']);
    await expect(page.locator('.pc-badge')).toContainText('Synthetic demo data');
    await expect(page.locator('.tp-note')).toContainText('Synthetic demo data');
    await expect(page.locator('.switcher')).toBeHidden();

    await page.getByRole('button', { name: 'Datasets' }).click();
    await expect(page.locator('.pg')).toHaveCount(0);
    await expect(page.locator('#status')).toHaveText(/100,000 cells$/, { timeout: 90_000 });
    await expect(page.locator('.switcher')).toBeVisible();
    // The selection chat is the one it always was: locked until cells are selected.
    await expect(page.locator('.chat-head')).toContainText('Ask about the selection');
    await expect(page.locator('.chat-badge')).toHaveText('no selection');
    await expect(page.locator('.chat-input textarea')).toBeDisabled();
  });

  test('clicking a fate on the map traces back to the stem cell on every panel', async ({ page }) => {
    test.slow();
    await openCreator(page);
    const f = await fate(page, 0);
    await clickMap(page, f.pos);
    await expect.poll(async () => (await snapshot(page)).target).toBe(f.id);

    const snap = await snapshot(page);
    expect(snap.traced[0]).toBe(0);
    expect(snap.traced.at(-1)).toBe(f.id);
    // The graph highlights exactly the traced milestones and lists them in order.
    await expect(page.locator('.tp-node.on')).toHaveCount(snap.traced.length);
    await expect(page.locator('.tp-list li')).toHaveCount(snap.traced.length);
    await expect(page.locator('.tp-list li').first()).toContainText('Synthetic stem cell');
    await expect(page.locator('.tp-list li').last()).toContainText('Synthetic fate');
    await expect(page.locator('.pc-target')).toContainText('Tracing');
    // The map draws the trace over the graph.
    const layers = await page.evaluate(() => window.__protocolCreator!.view.canvas.deck.props.layers.map(l => l.id));
    expect(layers).toContain('trace-line');
    expect(layers).toContain('trace-marks');
  });

  test('forks on the path say which branch is taken and what it rules out', async ({ page }) => {
    test.slow();
    await openCreator(page);
    const f = await fate(page, 3);
    await page.locator(`.tp-node[data-ms="${f.id}"] .tp-hit`).click();
    await expect.poll(async () => (await snapshot(page)).clicked).toBe(f.id);
    const forks = page.locator('.tp-fork');
    await expect(forks.first()).toContainText('rules out');
    await expect(forks.first()).toContainText('Synthetic fate');
  });

  test('a click on the graph selects the milestone on the map too', async ({ page }) => {
    test.slow();
    await openCreator(page);
    const f = await fate(page, 1);
    await page.locator(`.tp-node[data-ms="${f.id}"] .tp-hit`).click();
    await expect.poll(async () => (await snapshot(page)).clicked).toBe(f.id);
    await expect(page.locator('.node-card')).toBeVisible();
  });

  test('a timepoint slides along the clicked lineage, and along the busiest one when nothing is clicked', async ({ page }) => {
    test.slow();
    await openCreator(page);
    await page.locator('.pc-stages button', { hasText: 'P0' }).click();
    await expect(page.locator('.pc-target')).toContainText('lineage with the most cells');
    const byDefault = await snapshot(page);
    expect(byDefault.stage).toBe(3);
    expect(byDefault.clicked).toBeNull();
    expect(byDefault.traced[0]).toBe(0);

    // Clicking a fate makes it the lineage; the timepoint then moves along that one.
    const f = await fate(page, 2);
    await clickMap(page, f.pos);
    await expect.poll(async () => (await snapshot(page)).clicked).toBe(f.id);
    await expect(page.locator('.pc-target')).toContainText('along the clicked lineage');
    const along = await snapshot(page);
    expect(along.stage).toBe(3);
    expect(along.traced[0]).toBe(0);

    // An earlier stage moves the target toward the stem cell; clicking the chip again clears it.
    await page.locator('.pc-stages button', { hasText: 'E9.5' }).click();
    const early = await snapshot(page);
    expect(early.traced.length).toBeLessThanOrEqual(along.traced.length);
    await page.locator('.pc-stages button', { hasText: 'E9.5' }).click();
    expect((await snapshot(page)).stage).toBeNull();
  });

  test('stepping walks the path from the stem cell toward the target', async ({ page }) => {
    test.slow();
    await openCreator(page);
    const f = await fate(page, 0);
    await page.locator(`.tp-node[data-ms="${f.id}"] .tp-hit`).click();
    const full = await snapshot(page);
    expect(full.focus).toBe(full.traced.length - 1);
    await page.getByRole('button', { name: '◀', exact: true }).click();
    expect((await snapshot(page)).focus).toBe(full.traced.length - 2);
    await expect(page.locator('.tp-list li.focus')).toHaveCount(1);
    await page.getByRole('button', { name: 'Clear' }).click();
    expect((await snapshot(page)).traced).toEqual([]);
    await expect(page.locator('.tp-list li')).toHaveCount(0);
  });

  test('every panel expands to the main area, the others become thumbnails, and nothing is lost', async ({ page }) => {
    test.slow();
    await openCreator(page);
    const f = await fate(page, 0);
    await clickMap(page, f.pos);
    await expect.poll(async () => (await snapshot(page)).clicked).toBe(f.id);
    const before = await snapshot(page);

    // Put a message in the recipe chat, to see it survive.
    await page.locator('.pc-recipe textarea').fill('Give me a recipe');
    await page.locator('.pc-recipe .chat-input button').click();
    await expect(page.locator('.pc-recipe .msg.assistant')).toContainText('Synthetic demo data');
    const messages = await page.locator('.pc-recipe .msg').count();

    let first = true;
    for (const id of ['graph', 'recipe', 'map']) {
      // From the overview a panel's own button expands it; once one is
      // expanded the others are thumbnails, and a click on the tile does it.
      if (first) await page.locator(`[data-panel="${id}"] .pg-expand`).click();
      else await page.locator(`[data-panel="${id}"] .pg-restore`).click();
      first = false;
      await expect(page.locator('.pg')).toHaveAttribute('data-expanded', id);
      await expect(page.locator(`[data-panel="${id}"]`)).toHaveClass(/\bmain\b/);
      await expect(page.locator('.pg-panel.rail')).toHaveCount(2);
      await expect(page.locator('.pg-panel')).toHaveCount(3);
      const main = (await page.locator(`[data-panel="${id}"]`).boundingBox())!;
      for (const other of await page.locator('.pg-panel.rail').all()) {
        const r = (await other.boundingBox())!;
        expect(main.width * main.height).toBeGreaterThan(r.width * r.height * 2);
      }
      // Nothing was rebuilt: the same state, the same trace, the same conversation.
      expect(await snapshot(page)).toEqual(before);
      await expect(page.locator('.tp-node.on')).toHaveCount(before.traced.length);
      await expect(page.locator('.pc-recipe .msg')).toHaveCount(messages);
    }

    // Back to the overview with the button, then with Escape.
    await page.locator('[data-panel="map"] .pg-expand').click();
    await expect(page.locator('.pg')).toHaveAttribute('data-expanded', '');
    await page.locator('[data-panel="graph"] .pg-expand').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.pg')).toHaveAttribute('data-expanded', '');
    expect(await page.evaluate(() => window.__protocolCreator!.grid.expanded())).toBeNull();
  });

  test('the map canvas resizes with its panel and redraws at the new size', async ({ page }) => {
    test.slow();
    await openCreator(page);
    const canvas = page.locator('.pc-map canvas');
    const holder = page.locator('.pc-map .canvas-holder');
    const drawn = (): Promise<{ w: number; h: number; cssW: number; cssH: number; dpr: number }> =>
      canvas.evaluate(el => {
        const c = el as HTMLCanvasElement;
        return { w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight, dpr: window.devicePixelRatio };
      });
    // Software WebGL draws a 500k-point frame in tens of seconds, and the page
    // cannot answer a query while it does: measured, one expand froze the page
    // for 28 s and then the canvas was exactly the right size within 2.5 s. The
    // assertions are unchanged; only the wait for the page to come back is longer.
    const FRAME_STALL = 90_000;
    const consistent = async (): Promise<void> => {
      // The drawing buffer follows the element's CSS size, which follows the panel.
      await expect
        .poll(
          async () => {
            const d = await drawn();
            const h = (await holder.boundingBox())!;
            return Math.abs(d.cssW - h.width) < 2 && Math.abs(d.cssH - h.height) < 2 && Math.abs(d.w - d.cssW * d.dpr) < 2 * d.dpr;
          },
          { timeout: FRAME_STALL }
        )
        .toBe(true);
    };

    await consistent();
    const small = (await holder.boundingBox())!;

    await page.locator('[data-panel="map"] .pg-expand').click();
    await expect.poll(async () => (await holder.boundingBox())!.width, { timeout: FRAME_STALL }).toBeGreaterThan(small.width * 1.2);
    await consistent();
    const big = (await holder.boundingBox())!;
    // The graph is still where the projection says it is, inside the larger canvas.
    const inside = await page.evaluate(() => {
      const c = window.__protocolCreator!;
      const { width, height } = c.view.canvas.size();
      const m = c.tree.milestones.find(x => x.kind === 'terminal')!;
      const p = c.view.nodeScreenPosition(m.graphNodes[m.graphNodes.length - 1])!;
      return { width, height, x: p[0], y: p[1] };
    });
    expect(inside.width).toBeGreaterThan(small.width * 1.2);
    expect(inside.x).toBeGreaterThanOrEqual(0);
    expect(inside.x).toBeLessThanOrEqual(inside.width);
    expect(inside.y).toBeGreaterThanOrEqual(0);
    expect(inside.y).toBeLessThanOrEqual(inside.height);
    expect(Math.abs(inside.width - big.width)).toBeLessThan(2);

    await page.locator('[data-panel="map"] .pg-expand').click();
    await expect.poll(async () => Math.abs((await holder.boundingBox())!.width - small.width), { timeout: FRAME_STALL }).toBeLessThan(2);
    await consistent();

    // A thumbnail is smaller still, and the canvas follows that too.
    await page.locator('[data-panel="graph"] .pg-expand').click();
    await expect.poll(async () => (await holder.boundingBox())!.width, { timeout: FRAME_STALL }).toBeLessThan(small.width / 2);
    await consistent();
    await page.keyboard.press('Escape');
    await expect.poll(async () => Math.abs((await holder.boundingBox())!.width - small.width), { timeout: FRAME_STALL }).toBeLessThan(2);
    await consistent();
  });

  test('box and lasso selection are off in the compact map and come back when it is expanded', async ({ page }) => {
    test.slow();
    await openCreator(page);
    await expect(page.locator('.pc-map .side')).toBeHidden();
    await page.locator('[data-panel="map"] .pg-expand').click();
    await expect(page.locator('.pc-map .side')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Box', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lasso', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Box', exact: true }).click();
    const box = (await page.locator('.pc-map canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await page.mouse.down();
    for (let i = 1; i <= 4; i++) {
      await page.mouse.move(box.x + box.width * (0.3 + 0.1 * i), box.y + box.height * (0.3 + 0.1 * i));
    }
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => window.__protocolCreator!.view.selectionStore.current !== null), { timeout: 30_000 })
      .toBe(true);

    await page.locator('[data-panel="map"] .pg-expand').click();
    await expect(page.locator('.pc-map .side')).toBeHidden();
  });

  test('the recipe chat works with no selection and labels its answers as synthetic', async ({ page }) => {
    test.slow();
    await openCreator(page);
    await expect(page.locator('.pc-recipe .chat-head')).toContainText('Recipe maker (synthetic demo)');
    await expect(page.locator('.pc-recipe .chat-badge')).toBeHidden();
    const input = page.locator('.pc-recipe textarea');
    await expect(input).toBeEnabled();

    // Nothing traced yet: it says how to trace one.
    await input.fill('recipe?');
    await page.locator('.pc-recipe .chat-input button').click();
    await expect(page.locator('.pc-recipe .msg.assistant').last()).toContainText('Synthetic demo data');
    await expect(page.locator('.pc-recipe .msg.assistant').last()).toContainText(/click a milestone/i);

    // With a path traced, the recipe walks it from the stem cell.
    const f = await fate(page, 0);
    await page.locator(`.tp-node[data-ms="${f.id}"] .tp-hit`).click();
    await input.fill('recipe?');
    await page.locator('.pc-recipe .chat-input button').click();
    const answer = page.locator('.pc-recipe .msg.assistant').last();
    await expect(answer).toContainText('Synthetic stem cell');
    await expect(answer).toContainText('Synthetic fate');
    await expect(answer).toContainText('invented placeholder');
  });

  test('every theme restyles the creator and the trace stays drawn', async ({ page }) => {
    test.slow();
    await openCreator(page);
    const f = await fate(page, 0);
    await page.locator(`.tp-node[data-ms="${f.id}"] .tp-hit`).click();
    for (const theme of ['White', 'Grey', 'Light yellow', 'Black']) {
      await page.locator('.theme-picker button', { hasText: theme }).click();
      const layers = await page.evaluate(() => window.__protocolCreator!.view.canvas.deck.props.layers.map(l => l.id));
      expect(layers).toContain('trace-line');
      // The tree takes its colours from the theme's custom properties, not fixed ones.
      const [edge, bg] = await page.evaluate(() => [
        getComputedStyle(document.querySelector('.tp-edge.on')!).stroke,
        getComputedStyle(document.querySelector('.pg-panel')!).backgroundColor
      ]);
      expect(edge).not.toBe('none');
      expect(edge).not.toBe(bg);
    }
  });

  test('layout polish: the tree fits its panel, nothing overlaps it, and a thumbnail shows no node card', async ({ page }) => {
    test.slow();
    await openCreator(page);
    const f = await fate(page, 0);
    await page.locator(`.tp-node[data-ms="${f.id}"] .tp-hit`).click();
    await expect.poll(async () => (await snapshot(page)).clicked).toBe(f.id);

    const inside = (inner: { x: number; y: number; width: number; height: number }, outer: typeof inner): boolean =>
      inner.x >= outer.x - 1 &&
      inner.y >= outer.y - 1 &&
      inner.x + inner.width <= outer.x + outer.width + 1 &&
      inner.y + inner.height <= outer.y + outer.height + 1;
    const fits = async (): Promise<void> => {
      const body = (await page.locator('[data-panel="graph"] .pg-body').boundingBox())!;
      // The whole drawing, stem cell included, is in view without scrolling.
      expect(inside((await page.locator('.tp-svg').boundingBox())!, body)).toBe(true);
      expect(inside((await page.locator('.tp-node.kind-stem .tp-body').boundingBox())!, body)).toBe(true);
    };
    const noOverlap = async (): Promise<void> => {
      // The status line sits outside the panels, not over them.
      const status = (await page.locator('#status').boundingBox())!;
      const grid = (await page.locator('.pg').boundingBox())!;
      expect(status.y).toBeGreaterThanOrEqual(grid.y + grid.height - 1);
      // The axis title and its tick labels do not collide.
      const axes = await page.locator('.tp-axis').evaluateAll(els =>
        els.map(e => {
          const r = e.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        })
      );
      for (let i = 0; i < axes.length; i++) {
        for (let j = i + 1; j < axes.length; j++) {
          const a = axes[i];
          const b = axes[j];
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart, `axis labels ${i} and ${j} overlap`).toBe(true);
        }
      }
    };

    await fits();
    await noOverlap();
    // The milestone list is still there, below the drawing.
    await page.locator('.tp-steps').scrollIntoViewIfNeeded();
    await expect(page.locator('.tp-list li').first()).toBeVisible();
    await page.locator('[data-panel="graph"] .pg-body').evaluate(el => (el.scrollTop = 0));

    // Expanded, the drawing and the list are both on screen, and still nothing overlaps.
    await page.locator('[data-panel="graph"] .pg-expand').click();
    await expect(page.locator('.tp-list li').first()).toBeVisible();
    await fits();
    await noOverlap();

    // The map is a thumbnail now: its node card must not cover it.
    await expect(page.locator('[data-panel="map"] .node-card')).toBeHidden();
    await expect(page.locator('[data-panel="map"].rail .cell-card:visible')).toHaveCount(0);
    // Escape returns to the overview without closing the card or dropping the trace.
    const before = await snapshot(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.pg')).toHaveAttribute('data-expanded', '');
    expect(await snapshot(page)).toEqual(before);
    await expect(page.locator('[data-panel="map"] .node-card')).toBeVisible();
  });

  test('untraced elements stay readable in every theme and the traced path stays stronger', async ({ page }) => {
    test.slow();
    await openCreator(page);
    const f = await fate(page, 0);
    await page.locator(`.tp-node[data-ms="${f.id}"] .tp-hit`).click();
    await expect.poll(async () => (await snapshot(page)).clicked).toBe(f.id);

    for (const theme of ['White', 'Grey', 'Light yellow', 'Black']) {
      await page.locator('.theme-picker button', { hasText: theme }).click();
      const c = await page.evaluate(() => {
        const css = (sel: string, prop: string): string =>
          getComputedStyle(document.querySelector(sel)!).getPropertyValue(prop);
        return {
          panel: css('.pg-panel', 'background-color'),
          edgeOn: css('.tp-edge.on', 'stroke'),
          edgeOff: css('.tp-edge:not(.on)', 'stroke'),
          nodeOff: css('.tp-node:not(.on) .tp-body', 'stroke'),
          labelOff: css('.tp-node:not(.on) .tp-label', 'fill'),
          widthOn: parseFloat(css('.tp-edge.on', 'stroke-width')),
          widthOff: parseFloat(css('.tp-edge:not(.on)', 'stroke-width')),
          opacityOff: parseFloat(css('.tp-node:not(.on)', 'opacity'))
        };
      });
      const rgb = (s: string): [number, number, number] => {
        const m = /rgba?\(([^)]+)\)/.exec(s);
        if (m) return m[1].split(',').slice(0, 3).map(Number) as [number, number, number];
        const n = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(s);
        if (n) return [Number(n[1]) * 255, Number(n[2]) * 255, Number(n[3]) * 255];
        throw new Error(`cannot read colour "${s}"`);
      };
      const lum = ([r, g, b]: [number, number, number]): number => {
        const f2 = (v: number): number => ((v /= 255) <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
        return 0.2126 * f2(r) + 0.7152 * f2(g) + 0.0722 * f2(b);
      };
      const ratio = (a: string, b: string): number => {
        const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
      };
      const on = ratio(c.edgeOn, c.panel);
      // Lines and outlines meet the 3:1 non-text standard, labels the 4.5:1 text one.
      expect(ratio(c.edgeOff, c.panel), `${theme}: untraced edge`).toBeGreaterThanOrEqual(3);
      expect(ratio(c.nodeOff, c.panel), `${theme}: untraced node outline`).toBeGreaterThanOrEqual(3);
      expect(ratio(c.labelOff, c.panel), `${theme}: untraced label`).toBeGreaterThanOrEqual(4.5);
      // They are not faded with opacity, which would drag the label below that.
      expect(c.opacityOff, `${theme}: untraced node opacity`).toBe(1);
      // The selected lineage still wins: a stronger colour and a thicker stroke.
      expect(on, `${theme}: traced edge`).toBeGreaterThan(ratio(c.edgeOff, c.panel));
      expect(c.widthOn, `${theme}: stroke width`).toBeGreaterThan(c.widthOff);
    }
  });

  test('no console errors while using every panel', async ({ page }) => {
    test.slow();
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push(err.message));
    await openCreator(page);
    const f = await fate(page, 0);
    await clickMap(page, f.pos);
    await page.locator('.pc-stages button', { hasText: 'P7' }).click();
    await page.locator('[data-panel="graph"] .pg-expand').click();
    for (const id of ['recipe', 'map']) await page.locator(`[data-panel="${id}"] .pg-restore`).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Datasets' }).click();
    await page.waitForTimeout(500);
    expect(errors).toEqual([]);
  });
});
