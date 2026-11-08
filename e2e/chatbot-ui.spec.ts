import { expect, test, type Page } from '@playwright/test';

/**
 * How the Recipe Maker behaves when the server says the lab chatbot is, or is
 * not, available.
 *
 * Every response here is MOCKED in the browser with `page.route`. These tests
 * prove the page chooses the right backend, sends the right request and shows
 * each outcome correctly. They do not show that the lab server is reachable or
 * that any language model answered: that needs a real run of
 * `python -m server.chatbot_check --ask "..."` on a machine that reaches it.
 */
const CREATOR = '/?mode=protocol';

async function openCreator(page: Page): Promise<void> {
  await page.goto(CREATOR);
  await expect(page.locator('#status')).toHaveText(/synthetic demo data$/, { timeout: 120_000 });
}

const ready = { configured: true, ready: true, reason: 'ready' };

async function mockStatus(page: Page, body: object): Promise<void> {
  await page.route('**/api/chatbot/status', route => route.fulfill({ json: body }));
}

/** Traces a fate, so the question carries a path. */
async function traceAFate(page: Page): Promise<void> {
  const id = await page.evaluate(() => {
    const c = (window as unknown as { __protocolCreator: { tree: { milestones: { id: number; kind: string }[] } } }).__protocolCreator;
    return c.tree.milestones.find(m => m.kind === 'terminal')!.id;
  });
  await page.locator(`.tp-node[data-ms="${id}"] .tp-hit`).click();
  await expect(page.locator('.pc-target')).toContainText('Tracing');
}

async function ask(page: Page, text: string): Promise<void> {
  await page.locator('.pc-recipe textarea').fill(text);
  await page.locator('.pc-recipe .chat-input button').click();
}

test.describe('recipe maker and the lab chatbot (mocked server responses)', () => {
  test('uses the chatbot service when the server says it is ready, and shows its answer with sources', async ({ page }) => {
    test.slow();
    const posted: { question: string }[] = [];
    await mockStatus(page, ready);
    await page.route('**/api/chatbot/chat', async route => {
      posted.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          answer: 'MOCKED service answer.',
          blocked: false,
          sources: [{ text: 'a passage', source: 'protocol.pdf', score: 0.9 }, { text: 'b' }]
        }
      });
    });
    await openCreator(page);
    await expect(page.locator('[data-panel="recipe"] .pg-extra')).toHaveText('chatbot service');
    await traceAFate(page);
    await ask(page, 'How long does it take?');

    const answer = page.locator('.pc-recipe .msg.assistant').last();
    await expect(answer).toContainText('MOCKED service answer.');
    // Synthetic milestones are still labelled, whichever backend answers.
    await expect(answer).toContainText('Synthetic demo data');
    await expect(answer).toContainText('Sources:');
    await expect(answer).toContainText('protocol.pdf (0.90)');
    // Only the question travels, with the traced path in front of it, within the service's limit.
    expect(posted).toHaveLength(1);
    expect(Object.keys(posted[0])).toEqual(['question']);
    expect(posted[0].question).toMatch(/^\[Synthetic demo data\] Path from stem cell to target: Synthetic stem cell > /);
    expect(posted[0].question.endsWith('Question: How long does it take?')).toBe(true);
    expect(posted[0].question.length).toBeLessThanOrEqual(700);
  });

  test('shows each failure plainly, hides what the server said, and recovers when the service returns', async ({ page }) => {
    test.slow();
    await mockStatus(page, ready);
    type Mode = 'ok' | number | 'empty' | 'garbage';
    let mode: Mode = 409;
    let calls = 0;
    await page.route('**/api/chatbot/chat', async route => {
      calls++;
      if (mode === 'ok') return route.fulfill({ json: { answer: 'Back again.', blocked: false, sources: [] } });
      if (mode === 'empty') return route.fulfill({ json: { answer: '   ', blocked: false, sources: [] } });
      if (mode === 'garbage') return route.fulfill({ status: 200, body: '<html>proxy</html>', contentType: 'text/html' });
      return route.fulfill({ status: mode, json: { detail: 'secret detail at 192.168.2.228 /app/project' } });
    });
    await openCreator(page);
    await traceAFate(page);

    const expectations: [Mode, RegExp][] = [
      [409, /knowledge base has not been built/i],
      [502, /service is unavailable/i],
      [504, /took too long/i],
      [503, /not configured/i],
      [500, /request failed \(HTTP 500\)/i],
      ['empty', /empty reply/i],
      ['garbage', /unreadable reply/i]
    ];
    for (const [m, expected] of expectations) {
      mode = m;
      const before = await page.locator('.pc-recipe .msg.error').count();
      await ask(page, 'question');
      await expect(page.locator('.pc-recipe .msg.error')).toHaveCount(before + 1);
      const text = await page.locator('.pc-recipe .msg.error').last().textContent();
      expect(text).toMatch(expected);
      expect(text).not.toContain('192.168');
      expect(text).not.toContain('/app/project');
      // The panel is usable again straight away.
      await expect(page.locator('.pc-recipe textarea')).toBeEnabled();
      await expect(page.locator('.pc-recipe .chat-input button')).toBeEnabled();
    }
    expect(calls).toBe(expectations.length);

    mode = 'ok';
    await ask(page, 'are you back?');
    await expect(page.locator('.pc-recipe .msg.assistant').last()).toContainText('Back again.');
  });

  for (const reason of ['unreachable', 'not_built', 'not_configured', 'bad_reply'] as const) {
    test(`falls back to the labelled offline demo when the chatbot is ${reason}, and never calls the service`, async ({ page }) => {
      test.slow();
      let chatCalls = 0;
      await mockStatus(page, { configured: reason !== 'not_configured', ready: false, reason });
      await page.route('**/api/chatbot/chat', route => {
        chatCalls++;
        return route.abort();
      });
      await openCreator(page);
      await expect(page.locator('[data-panel="recipe"] .pg-extra')).toHaveText('offline demo');
      await traceAFate(page);
      await ask(page, 'recipe?');
      const answer = page.locator('.pc-recipe .msg.assistant').last();
      await expect(answer).toContainText('Synthetic demo data');
      await expect(answer).toContainText('invented placeholder');
      expect(chatCalls).toBe(0);
    });
  }

  test('falls back to the offline demo when the status route itself fails', async ({ page }) => {
    test.slow();
    await page.route('**/api/chatbot/status', route => route.fulfill({ status: 500, body: 'boom' }));
    await openCreator(page);
    await expect(page.locator('[data-panel="recipe"] .pg-extra')).toHaveText('offline demo');
  });

  test('the dashboard selection chat never touches the lab chatbot route', async ({ page }) => {
    test.slow();
    const touched: string[] = [];
    page.on('request', req => {
      if (req.url().includes('/api/chatbot')) touched.push(req.url());
    });
    await page.goto('/?dataset=sim100k');
    await expect(page.locator('#status')).toHaveText(/100,000 cells$/, { timeout: 90_000 });
    await page.getByRole('button', { name: 'Box', exact: true }).click();
    const box = (await page.locator('canvas').first().boundingBox())!;
    await page.mouse.move(box.x + 150, box.y + 120);
    await page.mouse.down();
    for (let i = 1; i <= 4; i++) await page.mouse.move(box.x + 150 + 80 * i, box.y + 120 + 50 * i);
    await page.mouse.up();
    await expect(page.locator('.chat-badge')).toContainText('cells', { timeout: 60_000 });
    await page.locator('.chat-input textarea').fill('what are these cells?');
    await page.getByRole('button', { name: 'Ask' }).click();
    await expect(page.locator('.msg.assistant').last()).not.toBeEmpty();
    expect(touched).toEqual([]);
  });
});
