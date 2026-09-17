import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: { '@core': resolve(__dirname, 'packages/core/src') } },
  test: { environment: 'node', include: ['packages/**/test/**/*.test.ts'] }
});
