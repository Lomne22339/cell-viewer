import { expect, test, type Page } from '@playwright/test';

/**
 * The Organ View: a body with three organs, and for the organ you pick its
 * parts, UMAP and trajectory. The organ datasets are simulated (`organ-*`
 * tiles from `server.prep --organ-size`), and the view must say so.
 *
 * The part and cell counts below are checked against the cell codes in the
 * browser, not against what the view reports about itself.
 */
const ORGAN = '/?mode=organ';
const ORGANS = [
  { id: 'heart', label: 'Heart', part: 'left_ventricle', level: 'left ventricle' },
  { id: 'brain', label: 'Brain', part: 'frontal_lobe', level: 'frontal lobe' },
  { id: 'liver', label: 'Liver', part: 'right_lobe', level: 'liver: right lobe' }
] as const;

interface View {
  store: { n: number; loadedCount: number; codes: Map<string, Uint16Array>; levels: Map<string, string[]> };
  selectionStore: { current: { indices: Uint32Array } | null };
}
interface OrganHandle {
  selected(): string | null;
  umap: View | null;
  trajectory: View | null;
  anatomy: unknown;
}
declare global {
  interface Window {
    __organView?: OrganHandle;
  }
}

async function openOverview(page: Page): Promise<void> {
  await page.goto(ORGAN);
  await expect(page.locator('.ov-card')).toHaveCount(3, { timeout: 60_000 });
}

async function openOrgan(page: Page, id: string): Promise<void> {
  await page.locator(`.ov-card[data-organ="${id}"]`).click();
  await expect(page.locator('.ov')).toHaveAttribute('data-organ', id);
  await expect
    .poll(() => page.evaluate(() => !!window.__organView?.umap && !!window.__organView?.trajectory), { timeout: 120_000 })
    .toBe(true);
}

/** Selected cell indices in each view, or null. */
const selections = (page: Page) =>
  page.evaluate(() => {
    const v = window.__organView!;
    const a = v.umap!.selectionStore.current?.indices;
    const b = v.trajectory!.selectionStore.current?.indices;
    return { umap: a ? Array.from(a) : null, trajectory: b ? Array.from(b) : null };
  });

/** How many cells carry `level` in `anatomical_region`, counted from the loaded codes. */
const cellsInRegion = (page: Page, level: string) =>
  page.evaluate(l => {
    const s = window.__organView!.umap!.store;
    const idx = s.levels.get('anatomical_region')!.indexOf(l);
    const codes = s.codes.get('anatomical_region')!;
    let n = 0;
    for (let i = 0; i < s.loadedCount; i++) if (codes[i] === idx) n++;
    return { idx, n };
  }, level);

const panelOf = (page: Page, name: string) => page.locator('.ov-detail .pg-panel', { has: page.getByRole('heading', { name }) });

test.describe('organ view', () => {
  test('the toggle shows a body with three organs joined to their cards, labelled synthetic, and returns to the dashboard', async ({ page }) => {
    test.slow();
    await page.goto('/?dataset=sim100k');
    await expect(page.locator('#status')).toHaveText(/100,000 cells$/, { timeout: 90_000 });
    // The simulated organ datasets are not offered as ordinary datasets.
    await expect(page.locator('.switcher button')).toHaveCount(4);
    await expect(page.locator('.switcher')).not.toContainText(/organ/i);

    await page.getByRole('button', { name: 'Organ view' }).click();
    await expect(page.locator('.ov-card')).toHaveCount(3, { timeout: 60_000 });
    // Top to bottom as they sit on the body, so no connector crosses another.
    await expect(page.locator('.ov-card b')).toHaveText(['Brain', 'Heart', 'Liver']);
    await expect(page.locator('.ov-body svg')).toBeVisible();
    await expect(page.locator('.ov-link')).toHaveCount(3);
    await expect(page.locator('.pc-badge')).toContainText('Synthetic demo data');
    await expect(page.locator('#status')).toContainText('synthetic demo data');
    await expect(page.locator('.switcher')).toBeHidden();
    await expect(page.locator('canvas')).toHaveCount(0);

    // Each connector runs from its organ on the body to its own card.
    const ends = await page.evaluate(() => {
      const inner = document.querySelector('.ov-overview-inner')!.getBoundingClientRect();
      return ['brain', 'heart', 'liver'].map(o => {
        const path = document.querySelector<SVGPathElement>(`.ov-link[data-organ="${o}"]`)!;
        const seg = document.querySelector(`.ov-body [data-seg="${o}"]`)!.getBoundingClientRect();
        const card = document.querySelector(`.ov-card[data-organ="${o}"]`)!.getBoundingClientRect();
        const len = path.getTotalLength();
        const a = path.getPointAtLength(0);
        const b = path.getPointAtLength(len);
        return {
          startInSeg:
            a.x + inner.x >= seg.x - 1 && a.x + inner.x <= seg.right + 1 && a.y + inner.y >= seg.y - 1 && a.y + inner.y <= seg.bottom + 1,
          endAtCard: Math.abs(b.x + inner.x - card.x) < 2 && b.y + inner.y > card.y && b.y + inner.y < card.bottom
        };
      });
    });
    for (const e of ends) expect(e).toEqual({ startInSeg: true, endAtCard: true });

    await page.getByRole('button', { name: 'Datasets' }).click();
    await expect(page.locator('.ov')).toHaveCount(0);
    await expect(page.locator('#status')).toHaveText(/100,000 cells$/, { timeout: 90_000 });
    await expect(page.locator('.chat-head')).toContainText('Ask about the selection');
    await expect(page.locator('.chat-badge')).toHaveText('no selection');
    await expect(page.locator('.switcher')).toBeVisible();
  });

  for (const o of ORGANS) {
    test(`${o.id}: maximises, shows its parts, and a part selects the same cells in the UMAP and the trajectory`, async ({ page }) => {
      test.slow();
      await openOverview(page);
      await openOrgan(page, o.id);

      await expect(page.locator('.ov-overview')).toBeHidden();
      await expect(page.locator('.ov-detail')).toBeVisible();
      await expect(page.locator('.ov-title')).toContainText(o.label);
      await expect(page.locator('.pc-badge')).toContainText('Synthetic demo data');
      // Navigation stays: the body and the three organs, the chosen one marked.
      await expect(page.locator('.ov-rail-item')).toHaveCount(4);
      await expect(page.locator('.ov-rail-item[aria-current="true"]')).toHaveText(o.label);
      // The two plots are the existing views, each with its own canvas.
      await expect(page.locator('canvas')).toHaveCount(2);
      await expect(panelOf(page, 'UMAP')).toContainText('30,000 cells');
      await expect(panelOf(page, 'Trajectory')).toContainText('30,000 cells');
      const same = await page.evaluate(() => {
        const v = window.__organView!;
        const a = v.umap!.store;
        const b = v.trajectory!.store;
        return { n: a.n === b.n, regions: JSON.stringify(a.levels.get('anatomical_region')) === JSON.stringify(b.levels.get('anatomical_region')) };
      });
      expect(same).toEqual({ n: true, regions: true });

      // Choose a part of the organ.
      const expected = await cellsInRegion(page, o.level);
      expect(expected.idx).toBeGreaterThanOrEqual(0);
      expect(expected.n).toBeGreaterThan(100);
      await page.locator(`.ov-figure .anatomy-figure .seg[data-seg="${o.part}"]`).click();
      await expect.poll(async () => (await selections(page)).trajectory?.length ?? 0, { timeout: 60_000 }).toBe(expected.n);
      const sel = await selections(page);
      expect(sel.umap).toEqual(sel.trajectory);
      expect(sel.umap!.length).toBe(expected.n);
      // Every selected cell really is in that part.
      const allInPart = await page.evaluate(
        ([idx]) => {
          const v = window.__organView!;
          const codes = v.umap!.store.codes.get('anatomical_region')!;
          const tcodes = v.trajectory!.store.codes.get('anatomical_region')!;
          const picked = v.trajectory!.selectionStore.current!.indices;
          for (const i of picked) if (codes[i] !== idx || tcodes[i] !== idx) return false;
          return true;
        },
        [expected.idx]
      );
      expect(allInPart).toBe(true);
      await expect(page.locator('.ov-summary')).toContainText(`${expected.n.toLocaleString()} of 30,000 cells selected`);
      await expect(page.locator(`.ov-figure .seg[data-seg="${o.part}"]`)).toHaveClass(/seg-selected/);

      // Clearing the part clears both plots.
      await page.getByRole('button', { name: 'Clear region selection' }).click();
      await expect.poll(async () => (await selections(page)).trajectory).toBeNull();
      expect((await selections(page)).umap).toBeNull();
      await expect(page.locator('.ov-summary')).toContainText('No cells selected');
    });
  }

  test('clicking an organ on the body opens it too', async ({ page }) => {
    test.slow();
    await openOverview(page);
    await page.locator('.ov-body [data-seg="heart"]').click();
    await expect(page.locator('.ov')).toHaveAttribute('data-organ', 'heart');
    await expect(page.locator('.ov-title')).toContainText('Heart');
  });

  test('a box drawn on the trajectory selects the same cells in the UMAP and shades the figure', async ({ page }) => {
    test.slow();
    await openOverview(page);
    await openOrgan(page, 'heart');
    const traj = panelOf(page, 'Trajectory');
    await traj.getByRole('button', { name: 'Box', exact: true }).click();
    const box = (await traj.locator('canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.35);
    await page.mouse.down();
    for (let i = 1; i <= 4; i++) await page.mouse.move(box.x + box.width * (0.2 + 0.15 * i), box.y + box.height * (0.35 + 0.1 * i));
    await page.mouse.up();
    await expect.poll(async () => (await selections(page)).umap?.length ?? 0, { timeout: 90_000 }).toBeGreaterThan(0);
    const sel = await selections(page);
    expect(sel.trajectory).toEqual(sel.umap);
    // The figure now describes the selection: the summary line counts it.
    await expect(page.locator('.ov-figure .anatomy-actions')).toContainText(/selected cells map to heart/i);
    await expect(page.locator('.ov-summary')).toContainText('cells selected, in the UMAP and the trajectory');
  });

  test('the rail moves between organs and back to the body, without leaving canvases behind', async ({ page }) => {
    test.slow();
    await openOverview(page);
    await openOrgan(page, 'heart');
    await page.locator('.ov-rail-item[data-nav="brain"]').click();
    await expect(page.locator('.ov')).toHaveAttribute('data-organ', 'brain');
    await expect(page.locator('.ov-rail-item[aria-current="true"]')).toHaveText('Brain');
    await expect
      .poll(() => page.evaluate(() => window.__organView?.selected()), { timeout: 120_000 })
      .toBe('brain');
    await expect(panelOf(page, 'UMAP')).toContainText('30,000 cells', { timeout: 120_000 });
    await expect(page.locator('canvas')).toHaveCount(2);
    // A selection in one organ is not carried into the next.
    expect((await selections(page)).umap).toBeNull();

    await page.locator('.ov-rail-item[data-nav="overview"]').click();
    await expect(page.locator('.ov-card')).toHaveCount(3);
    await expect(page.locator('canvas')).toHaveCount(0);
    await page.locator(`.ov-card[data-organ="liver"]`).click();
    await expect(page.locator('.ov-title')).toContainText('Liver');
    await page.getByRole('button', { name: '◀ All organs' }).click();
    await expect(page.locator('.ov-card')).toHaveCount(3);
    await expect(page.locator('canvas')).toHaveCount(0);
  });

  test('on a narrow window the parts and both plots still fit, side by side or stacked, without overlapping', async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 900, height: 760 });
    await openOverview(page);
    await openOrgan(page, 'heart');
    await expect(panelOf(page, 'UMAP').locator('canvas')).toBeVisible();
    const boxes = await page.evaluate(() =>
      ['parts', 'UMAP', 'Trajectory'].map(name => {
        const panel = [...document.querySelectorAll('.ov-detail .pg-panel')].find(p =>
          p.querySelector('h2')!.textContent!.includes(name)
        )!;
        const r = panel.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })
    );
    for (const b of boxes) {
      expect(b.w).toBeGreaterThan(150);
      expect(b.h).toBeGreaterThan(120);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(900 + 1);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const apart = a.x + a.w <= b.x + 1 || b.x + b.w <= a.x + 1 || a.y + a.h <= b.y + 1 || b.y + b.h <= a.y + 1;
        expect(apart, `panels ${i} and ${j} overlap`).toBe(true);
      }
    }
    // A part can still be chosen there.
    await page.locator('.ov-figure .anatomy-figure .seg[data-seg="left_ventricle"]').click();
    await expect.poll(async () => (await selections(page)).trajectory?.length ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
  });

  test('every theme restyles the view and keeps the selection', async ({ page }) => {
    test.slow();
    await openOverview(page);
    await openOrgan(page, 'liver');
    await page.locator('.ov-figure .anatomy-figure .seg[data-seg="right_lobe"]').click();
    await expect.poll(async () => (await selections(page)).umap?.length ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
    const before = await selections(page);
    for (const theme of ['White', 'Grey', 'Light yellow', 'Black']) {
      await page.locator('.theme-picker button', { hasText: theme }).click();
      const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.ov-detail')!).backgroundColor);
      const panel = await page.evaluate(() => getComputedStyle(document.querySelector('.pg-panel')!).backgroundColor);
      expect(bg).not.toBe(panel);
      expect(await selections(page)).toEqual(before);
      await expect(page.locator('canvas')).toHaveCount(2);
      await expect(page.locator('.ov-figure .seg[data-seg="right_lobe"]')).toHaveClass(/seg-selected/);
    }
  });

  test('moves between the dashboard, the organ view and the protocol creator without breaking any of them', async ({ page }) => {
    test.slow();
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/?dataset=sim100k');
    await expect(page.locator('#status')).toHaveText(/100,000 cells$/, { timeout: 90_000 });

    await page.getByRole('button', { name: 'Organ view' }).click();
    await expect(page.locator('.ov-card')).toHaveCount(3, { timeout: 60_000 });
    await openOrgan(page, 'heart');
    await expect(page.locator('canvas')).toHaveCount(2);

    await page.getByRole('button', { name: 'Protocol creator' }).click();
    await expect(page.locator('.pg-panel')).toHaveCount(3, { timeout: 60_000 });
    await expect(page.locator('.ov')).toHaveCount(0);
    await expect(page.locator('#status')).toHaveText(/synthetic demo data$/, { timeout: 120_000 });
    await expect(page.locator('canvas')).toHaveCount(1);
    await expect(page.locator('.pc-badge')).toContainText('Synthetic demo data');
    // The recipe maker still answers, and says it is the offline demo.
    await expect(page.locator('.pg-extra').last()).toHaveText('offline demo');
    await page.locator('.pc-recipe textarea').fill('recipe?');
    await page.locator('.pc-recipe .chat-input button').click();
    await expect(page.locator('.pc-recipe .msg.assistant').last()).toContainText('Synthetic demo data');

    await page.getByRole('button', { name: 'Organ view' }).click();
    await expect(page.locator('.ov-card')).toHaveCount(3, { timeout: 60_000 });
    await expect(page.locator('.pg-panel')).toHaveCount(0);
    await expect(page.locator('canvas')).toHaveCount(0);

    await page.getByRole('button', { name: 'Datasets' }).click();
    await expect(page.locator('#status')).toHaveText(/100,000 cells$/, { timeout: 90_000 });
    await expect(page.locator('canvas')).toHaveCount(1);
    await expect(page.locator('.chat-badge')).toHaveText('no selection');
    expect(errors).toEqual([]);
  });

  test('says how to build the data when the organ datasets are not there', async ({ page }) => {
    await page.route('**/api/datasets', async route => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { datasets: body.datasets.filter((d: string) => !d.startsWith('organ-')) } });
    });
    await page.goto(ORGAN);
    await expect(page.locator('.ov-card')).toHaveCount(3, { timeout: 60_000 });
    await expect(page.locator('.ov-card:disabled')).toHaveCount(3);
    await expect(page.locator('.ov-missing')).toContainText('--organ-size');
    await expect(page.locator('.pc-badge')).toBeHidden();
  });
});
