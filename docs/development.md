# Development

You must have Node 20 or later.

| Command | What it does |
| --- | --- |
| `npm ci` | Install the locked dependencies. |
| `npm run build` | Remove `dist/`. Use `tsc` to make the core and `./workers`. Use esbuild to bundle `dist/js-worker.js`. Then run `scripts/verify-build.mjs`. |
| `npm test` | Run the unit specs with Vitest under jsdom (`vitest.config.ts`). There, the engine runs in-process. |
| `npm run test:integration` | Run the specs in a real browser: headless Chromium through Playwright (`vitest.integration.config.ts`). They use a real `Worker` and a real IndexedDB. |
| `npm run lint` | Run ESLint (flat config, `eslint.config.js`). This includes the import boundaries between the core and the workers. |
| `npm run format` | Format the code, JSON, YAML and HTML with Prettier (`.prettierrc.json`). Prettier does not format Markdown. |
| `npm run format:check` | Make sure that all files have the Prettier format. CI runs this command. |
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
  specs end in `.integration.spec.ts`. Use this name for a spec that must
  have a real `Worker` or a real IndexedDB. Do not skip a spec.
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

The release workflow (`.github/workflows/release.yml`) stages a version
on npm only when you push a tag `vX.Y.Z` or `vX.Y.Z-pre`. A push to a
branch never stages. A staged version is not public until you approve it
with 2FA. A pre-release goes to the `next` dist-tag. npm adds provenance
to each version.

1. Update `CHANGELOG.md` and the `version` in `package.json`.
2. Commit the changes and push them to `main`.
3. Make sure that CI passes on that commit.
4. Tag the commit `vX.Y.Z` and push the tag.
5. Wait for the release workflow to pass.
6. Get the stage ID with `npm stage list tethered`.
7. Download the staged tarball with `npm stage download <stage-id>`.
8. Examine the tarball. Optionally, install it in a test project.
9. Approve the version with `npm stage approve <stage-id>`. You can also
   approve it on the Staged Packages tab on npmjs.com.

The workflow stops if the tag is not the `version` in `package.json`, or
if the tagged commit is not on `main`. It runs all checks before it
stages the version.

### One-time setup

1. Turn on 2FA for your npm account. Approval of a staged version must
   have 2FA.
2. On npmjs.com, make a granular access token with read and write access
   to all packages. Do not let it skip 2FA. Staging does not need 2FA,
   thus a stolen token cannot make a version public. After the first
   release, make a new token that has access only to `tethered`.
3. In the GitHub repository, add the `npm` environment (Settings >
   Environments). Optionally, add yourself as a required reviewer.
4. Add the token to that environment as the `NPM_TOKEN` secret.
5. Add a tag ruleset for `v*` so that only you can push release tags.
