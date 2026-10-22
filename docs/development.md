# Development

Requires Node 20 or later.

| Command | What it does |
| --- | --- |
| `npm ci` | Install the locked dependencies. |
| `npm run build` | Clean `dist/`, emit the core and `./workers` with `tsc`, bundle `dist/js-worker.js` with esbuild, then run `scripts/verify-build.mjs`. |
| `npm test` | Unit specs with Vitest under jsdom (`vitest.config.ts`). The engine runs in-process there. |
| `npm run test:integration` | Real-browser specs in headless Chromium through Playwright (`vitest.integration.config.ts`): a real `Worker`, real IndexedDB. |
| `npm run lint` | ESLint (flat config, `eslint.config.js`), including the core/worker import boundaries. |
| `npm run typecheck` | `tsc --noEmit` over sources, specs, configs and the demo. |
| `npm run dev:demo` | Serve the demo page (`demo/`) with Vite. |
| `npm run build:demo` | Build the demo into `demo/dist/`. |
| `npm run preview:demo` | Serve the built demo. |

## Browser for the integration suite

The suite needs Playwright's headless Chromium for the pinned
`playwright` version:

```bash
npx playwright install chromium-headless-shell
```

CI installs it the same way.

## Tests

- Specs sit next to the code (`*.spec.ts`). Browser-only specs end in
  `.integration.spec.ts`; `sandbox-disk-db.spec.ts` also runs in the
  browser suite because it needs a real IndexedDB.
- Spec names that start with an id such as `A32:` refer to a behaviour
  that was specified and verified when the code was written. Keep the id
  when you change such a spec.
- New behaviour comes with a spec that fails without it.

## Demo

`demo/` is a framework-free page that runs guest code with Run and Stop
buttons, capability toggles and a fetch allowlist. It imports the package
source and lets Vite bundle the worker from
`new URL('../src/js-worker.ts', import.meta.url)`.
`.github/workflows/pages.yml` builds it and deploys it to GitHub Pages on
every push to `main` (set Settings > Pages > Source to GitHub Actions).

The page needs no COOP/COEP headers: the worker does not use
`SharedArrayBuffer`, so it runs without cross-origin isolation. That
matters because GitHub Pages cannot set response headers; a page that
needed them would have to add a service-worker shim.

## Releasing

1. Update `CHANGELOG.md` and the `version` in `package.json`.
2. Commit, then tag `vX.Y.Z` and push the tag.
3. The release workflow (`.github/workflows/release.yml`) builds, tests
   and publishes to npm with provenance. It needs an `NPM_TOKEN`
   repository secret.
