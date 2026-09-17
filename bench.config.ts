import { defineConfig } from '@playwright/test';

/**
 * Capacity sweep configuration.
 *
 * Runs headed on purpose: headless Chromium falls back to SwiftShader and
 * rasterises every point on the CPU, which measures the CPU rather than the
 * machine anyone would actually use. A headed window on macOS gets the real
 * GPU through ANGLE/Metal.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/capacity.spec.ts',
  timeout: 30 * 60_000,
  expect: { timeout: 20 * 60_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    headless: false,
    viewport: { width: 1440, height: 900 }
  },
  webServer: [
    {
      command: '.venv/bin/python -m uvicorn server.main:app --port 8000 --log-level warning',
      url: 'http://localhost:8000/api/datasets',
      reuseExistingServer: true,
      timeout: 60_000
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000
    }
  ]
});
