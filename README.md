# tethered

Run untrusted JavaScript in the browser, on a tether: guest code runs in a
Web Worker and can reach the host only through the capabilities you
register.

- Guest code runs in a sandboxed JS engine (WebAssembly) inside a
  dedicated `Worker`, off the main thread.
- Side effects (fetch, storage, a virtual disk, timers, or your own) are
  opt-in capabilities, checked on the host for every call.
- Every run has a time limit and a memory limit; `abort()` stops even a
  `while (true) {}`.
- The core is framework-free and dependency-free; the engine stays an
  implementation detail of the worker.

## Install

```bash
npm install tethered
```

## Quick start

```ts
import { createSandboxRuntime, FetchCapability } from 'tethered';
import jsWorkerUrl from 'tethered/js-worker?url'; // Vite; see docs/usage.md for other bundlers

const rt = createSandboxRuntime({
  jsWorkerFactory: () => new Worker(jsWorkerUrl, { type: 'module' }),
});
rt.registry.register(new FetchCapability(rt.auth, { allowHosts: ['api.example.com'] }));
rt.registry.setEnabled('fetch', true);

await rt.js.initialize(); // boots the worker; rejects if it fails to load
const result = await rt.facade.execute(`
  const res = fetch('https://api.example.com/items'); // host calls look synchronous to the guest
  console.log(res.status);
  res.json().length
`);
console.log(result.success, result.output);
rt.dispose();
```

## Security

> Guest JavaScript run by the built-in JS runner, inside a real web
> `Worker`, cannot read or change host state and cannot cause side
> effects, except through the capabilities the host registered and
> enabled for that run. Each run is bounded by its time limit and a
> per-run memory limit. The claim covers the built-in JS runner only.

The in-process fallback (for jsdom/SSR tests), custom runners and custom
capabilities are outside the claim. Read the
[threat model](docs/threat-model.md) before exposing a capability, and
report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Stability

tethered is 0.x. Until 1.0, a minor release (0.x.0) may break the API and
a patch release (0.x.y) will not. Every breaking change is listed in the
[changelog](CHANGELOG.md).

## Docs

- [Usage](docs/usage.md): bundler setup, capabilities, extra runners,
  reactive state.
- [Run lifecycle](docs/run-lifecycle.md): per-run options, supersede and
  queue, abort, boot and initialization.
- [Threat model](docs/threat-model.md): the security claim, what is in
  and out of scope, each capability's attack surface.
- [Proxy protocol](docs/proxy-protocol.md): how `FetchCapability` talks to
  a CORS proxy, and what a proxy must do.
- [Architecture](docs/architecture.md): entry points, source layout, how
  the worker boundary works.
- [Development](docs/development.md): build, test, lint, release.
- [Demo](demo/main.ts): a small vanilla TS playground (`npm run dev:demo`), deployed to GitHub Pages.

## License

[MIT](LICENSE)
