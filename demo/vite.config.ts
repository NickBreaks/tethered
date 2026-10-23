import { defineConfig } from 'vite';

/**
 * The demo page: `npm run dev:demo`, `npm run build:demo` (to demo/dist/),
 * `npm run preview:demo`.
 *
 * No COOP/COEP headers: the worker uses no SharedArrayBuffer, so the page
 * does not need cross-origin isolation. Also, a local server without these
 * headers matches GitHub Pages, which cannot set response headers.
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
