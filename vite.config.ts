import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * The page calls `/api/...` on its own origin; Vite forwards those requests to
 * the FastAPI server. Same-origin requests need no CORS, so the app works on
 * whatever port Vite ends up on (5174 when 5173 is busy). Override the target
 * with `API_TARGET=http://host:port npm run dev`.
 */
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
        bench: resolve(__dirname, 'apps/web/bench.html'),
        diag: resolve(__dirname, 'apps/web/diag.html'),
        anatomy: resolve(__dirname, 'apps/web/anatomy.html')
      }
    }
  }
});
