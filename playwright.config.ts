import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // The capacity sweep needs a real GPU and its own long timeouts; it has its
  // own config and is never part of the correctness run.
  testIgnore: ['**/capacity.spec.ts'],
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    // Software WebGL is enough for correctness; the /bench page measures speed
    // on the real GPU.
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] }
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
