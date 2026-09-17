import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'apps/web',
  resolve: { alias: { '@core': resolve(__dirname, 'packages/core/src') } },
  server: { port: 5173 },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'apps/web/index.html'),
        bench: resolve(__dirname, 'apps/web/bench.html'),
        diag: resolve(__dirname, 'apps/web/diag.html')
      }
    }
  }
});
