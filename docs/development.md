# Development

You must have Node 20 or later.

| Command | What it does |
| --- | --- |
| `npm ci` | Install the locked dependencies. |
| `npm run build` | Remove `dist/`. Use `tsc` to make the core and `./workers`. Use esbuild to bundle `dist/js-worker.js`. Then run `scripts/verify-build.mjs`. |
| `npm test` | Run the unit specs with Vitest under jsdom (`vitest.config.ts`). There, the engine runs in-process. |
| `npm run test:integration` | Run the specs in a real browser: headless Chromium through Playwright (`vitest.integration.config.ts`). They use a real `Worker` and a real IndexedDB. |
| `npm run lint` | Run ESLint (flat config, `eslint.config.js`). This includes the import boundaries between the core and the workers. |
| `npm run typecheck` | Run `tsc --noEmit` on the sources, specs, configs and the demo. |
| `npm run dev:demo` | Serve the demo page (`demo/`) with Vite. |
| `npm run build:demo` | Build the demo into `demo/dist/`. |
| `npm run preview:demo` | Serve the built demo. |

## Browser for the integration suite

The suite must have the Playwright headless Chromium for the pinned
`playwright` version. Install it:

```bash
npx playwright install chromium-headless-shell
```

CI uses the same procedure.

## Tests

- Specs are adjacent to the code (`*.spec.ts`). The names of browser-only
  specs end in `.integration.spec.ts`. `sandbox-disk-db.spec.ts` also runs
  in the browser suite, because it must have a real IndexedDB.
- Some spec names start with an id, for example `A32:`. This id refers to
  a behaviour that the author specified and verified with the code. When
  you change such a spec, keep the id.
- For each new behaviour, add a spec that fails without that behaviour.

## Writing style

Docs and code comments follow ASD-STE100 (Simplified Technical English).
Refer to [Writing style](writing-style.md).

## Demo

`demo/` is a page without a framework. It runs guest code, and has Run and
Stop buttons, capability switches and a fetch allowlist. It imports the
package source. Vite bundles the worker from
`new URL('../src/js-worker.ts', import.meta.url)`.
`.github/workflows/pages.yml` builds the demo and deploys it to GitHub
Pages on every push to `main`. To enable this, set Settings > Pages >
Source to GitHub Actions.

The page does not have to send COOP/COEP headers. The worker does not use
`SharedArrayBuffer`, thus it runs without cross-origin isolation. This is
important because GitHub Pages cannot set response headers. If a page must
have these headers, it must add a service-worker shim.

## Releasing

1. Update `CHANGELOG.md` and the `version` in `package.json`.
2. Commit the changes.
3. Tag the commit `vX.Y.Z` and push the tag.
4. The release workflow (`.github/workflows/release.yml`) builds, tests
   and publishes to npm with provenance. The workflow must have an
   `NPM_TOKEN` repository secret.
