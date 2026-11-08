import { expect, test, type CDPSession, type Page } from '@playwright/test';

/**
 * Replacing a view must let go of the old one's cell data.
 *
 * Found by heap snapshot: after `deck.finalize()` the graphics library still
 * holds the removed `<canvas>` (through a device-pixel-ratio media-query
 * listener), and the canvas's own listeners pointed back at the view, so every
 * dataset switch kept the old view and all its typed arrays alive. WeakRefs
 * to the old view and its arrays must be empty after a garbage collection.
 */
/** The test handles the app puts on `window`, typed here so other specs' declarations do not clash. */
type Handles = {
  __weak?: Record<string, WeakRef<object>>;
  __cellViewer?: { view: { store: { xy: Float32Array } } };
  __organView?: { umap: { store: { xy: Float32Array } } | null };
};

async function collect(page: Page, cdp: CDPSession): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForTimeout(250);
  }
}

const alive = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as Handles;
    return Object.fromEntries(Object.entries(w.__weak!).map(([k, r]) => [k, r.deref() !== undefined]));
  });

test.describe('memory', () => {
  test('switching datasets does not keep the old view or its cell arrays', async ({ page }) => {
    test.slow();
    const cdp = await page.context().newCDPSession(page);
    await page.goto('/?dataset=sim100k');
    await expect(page.locator('#status')).toHaveText(/100,000 cells$/, { timeout: 90_000 });
    await page.evaluate(() => {
      const w = window as unknown as Handles;
      const v = w.__cellViewer!.view;
      w.__weak = { view: new WeakRef(v), xy: new WeakRef(v.store.xy.buffer) };
    });
    await page.locator('.switcher button', { hasText: 'Atlas' }).click();
    await expect(page.locator('#status')).toHaveText(/300,000 cells$/, { timeout: 90_000 });
    await page.waitForTimeout(1000);
    await collect(page, cdp);
    expect(await alive(page)).toEqual({ view: false, xy: false });
  });

  test('closing an organ lets go of its two views and their cells', async ({ page }) => {
    test.slow();
    const cdp = await page.context().newCDPSession(page);
    await page.goto('/?mode=organ');
    await expect(page.locator('.ov-card')).toHaveCount(3, { timeout: 60_000 });
    await page.locator('.ov-card[data-organ="heart"]').click();
    await expect
      .poll(() => page.evaluate(() => !!(window as unknown as Handles).__organView?.umap), { timeout: 120_000 })
      .toBe(true);
    await page.evaluate(() => {
      const w = window as unknown as Handles;
      const u = w.__organView!.umap!;
      w.__weak = { view: new WeakRef(u), xy: new WeakRef(u.store.xy.buffer) };
    });
    await page.getByRole('button', { name: '◀ All organs' }).click();
    await expect(page.locator('.ov-card')).toHaveCount(3);
    await page.waitForTimeout(1000);
    await collect(page, cdp);
    expect(await alive(page)).toEqual({ view: false, xy: false });
  });
});
