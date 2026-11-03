import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/** `/api` is forwarded to FastAPI, keeping the page same-origin (no CORS); override: `API_TARGET`. */
const apiProxy = {
  '/api': { target: process.env.API_TARGET ?? 'http://localhost:8000', changeOrigin: true }
};

export default defineConfig({
  root: 'apps/web',
  resolve: { alias: { '@core': resolve(__dirname, 'packages/core/src') } },
  server: { port: 5173, proxy: apiProxy },
  preview: { proxy: apiProxy },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'apps/web/index.html'),
        anatomy: resolve(__dirname, 'apps/web/anatomy.html')
      }
    }
  }
});
