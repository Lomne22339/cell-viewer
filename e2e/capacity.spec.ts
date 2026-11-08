import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * Drives the /bench.html sweep and writes the result to
 * docs/benchmarks/capacity-latest.md.
 *
 * This is a measurement run, not an assertion: the question it answers is
 * "how far does this machine actually go", and any answer is a valid one.
 * The only failure mode is not getting numbers at all.
 */
test('render diagnostics', async ({ page }) => {
  const lines: string[] = [];
  page.on('console', m => lines.push(m.text()));

  await page.goto('/diag.html?dataset=sim1m');
  await page.getByRole('button', { name: 'Run diagnostics' }).click();
  await page.locator('#log').filter({ hasText: 'done' }).waitFor({ timeout: 10 * 60_000 });
  const table = (await page.locator('#out').textContent()) ?? '';
  console.log('\n===== RENDER DIAGNOSTICS =====\n' + table + '\n=============================');
});

test('capacity sweep', async ({ page }) => {
  const lines: string[] = [];
  page.on('console', m => lines.push(m.text()));

  await page.goto('/bench.html');
  await page.getByRole('button', { name: 'Run sweep' }).click();

  // The sweep writes the table into #out as each size completes and logs
  // "done" when the last one lands.
  await page.locator('#log').filter({ hasText: 'done' }).waitFor({ timeout: 25 * 60_000 });
  const table = (await page.locator('#out').textContent()) ?? '';

  await page.getByRole('button', { name: /Radius comparison/ }).click();
  await page.locator('#log').filter({ hasText: 'done' }).waitFor({ timeout: 10 * 60_000 });
  const withRadius = (await page.locator('#out').textContent()) ?? table;

  const ua = await page.evaluate(() => navigator.userAgent);
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });

  mkdirSync('docs/benchmarks', { recursive: true });
  writeFileSync(
    'docs/benchmarks/capacity-latest.md',
    `# Capacity sweep — measured\n\n` +
      `Date: ${new Date().toISOString().slice(0, 10)}\n` +
      `Renderer: ${renderer}\n` +
      `User agent: ${ua}\n\n` +
      `${withRadius}\n`
  );
  console.log('\n===== PAGE DIAGNOSTICS =====');
  for (const l of lines) if (l.startsWith('[diag]')) console.log(l);
  console.log('\n===== CAPACITY SWEEP =====\n' + withRadius + '\n==========================');
});
