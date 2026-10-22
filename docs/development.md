# Development

Requires Node 20 or later.

| Command | What it does |
| --- | --- |
| `npm ci` | Install the locked dependencies. |
| `npm run build` | Clean `dist/`, emit the core and `./workers` with `tsc`, bundle `dist/js-worker.js` with esbuild, then run `scripts/verify-build.mjs`. |
| `npm test` | Unit specs with Vitest under jsdom (`vitest.config.ts`). The engine runs in-process there. |
| `npm run test:integration` | Real-browser specs in headless Chromium through Playwright (`vitest.integration.config.ts`): a real `Worker`, real IndexedDB. |
| `npm run lint` | ESLint (flat config, `eslint.config.js`), including the core/worker import boundaries. |
| `npm run typecheck` | `tsc --noEmit` over sources, specs and configs. |

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

## Releasing

1. Update `CHANGELOG.md` and the `version` in `package.json`.
2. Commit, then tag `vX.Y.Z` and push the tag.
3. The release workflow (`.github/workflows/release.yml`) builds, tests
   and publishes to npm with provenance. It needs an `NPM_TOKEN`
   repository secret.
