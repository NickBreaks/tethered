import { defineConfig } from 'vite';

/**
 * The demo page: `npm run dev:demo`, `npm run build:demo` (to demo/dist/),
 * `npm run preview:demo`.
 *
 * No COOP/COEP headers: the worker uses no SharedArrayBuffer, so the page
 * needn't be cross-origin isolated, and serving it locally without them
 * matches GitHub Pages, which can't set response headers.
 */
export default defineConfig({
  // Relative to the working directory: the npm scripts run from the package root.
  root: 'demo',
  // Relative asset URLs, so the build works under any Pages subpath.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The worker bundle inlines the engine's WASM (about 1.6 MB).
    chunkSizeWarningLimit: 2500,
  },
  worker: { format: 'es' },
});
