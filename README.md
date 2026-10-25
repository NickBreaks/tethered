# tethered

Run untrusted JavaScript in the browser, on a tether. Guest code runs in a
Web Worker. It can get access to the host only through the capabilities
that you register.

- Guest code runs in a sandboxed JS engine (WebAssembly) inside a
  dedicated `Worker`, off the main thread.
- Side effects are opt-in capabilities: fetch, storage, a virtual disk,
  timers, or your own. The host checks each capability for every call.
- Every run has a time limit and a memory limit. `abort()` stops even a
  `while (true) {}`.
- The core has no framework and no dependencies. The engine is an
  internal part of the worker only.

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

await rt.js.initialize(); // starts the worker; rejects if the worker does not load
const result = await rt.facade.execute(`
  const res = fetch('https://api.example.com/items'); // host calls look synchronous to the guest
  console.log(res.status);
  res.json().length
`);
console.log(result.success, result.output);
rt.dispose();
```

## Browser support

tethered must have module workers (`new Worker(url, { type: 'module' })`)
and WebAssembly. The disk capability also uses IndexedDB. CI runs the
browser suite on Chromium only. Other browsers with these features
should work, but CI does not test them.

## Security

Caution: no independent party has reviewed or audited tethered. The
tests and the reviews of the maintainer examine the goal, but they cannot
prove it. Do not use tethered as the only barrier between hostile code
and data or credentials that you must keep safe.

tethered has this security goal:

> Guest JavaScript run by the built-in JS runner, inside a real web
> `Worker`, cannot read or change host state and cannot cause side
> effects, except through the capabilities the host registered and
> enabled for that run. Each run is bounded by its time limit (with a
> 2 s backstop) and a per-run memory limit. The goal covers the
> built-in JS runner only.

The goal does not include the in-process fallback (for jsdom/SSR tests),
custom runners or custom capabilities. Read the
[threat model](docs/threat-model.md) before you give guest code access to a
capability. Report vulnerabilities privately as
[SECURITY.md](SECURITY.md) tells you.

## Stability

tethered is 0.x. Until 1.0, a minor release (0.x.0) can break the API. A
patch release (0.x.y) will not break the API. The
[changelog](CHANGELOG.md) lists every breaking change.

## Known issues

These issues come from the engine (quickjs-emscripten-core 0.32.0).

- An unhandled promise rejection does not fail the run. The worker drops
  an exception in a `.then()` handler or in an `async` function, and the
  run reports success. A rejected top-level result fails the run. Refer
  to the [timer capability](docs/threat-model.md#timer-timercapability).
- Most deep recursions replace the worker. The stack of the browser
  overflows before the engine limit, so the guest cannot catch the
  error. The run fails, and the runner replaces the worker. Refer to the
  stack limit in the [threat model](docs/threat-model.md#in-scope).

## Docs

- [Usage](docs/usage.md): bundler setup, capabilities, extra runners,
  reactive state.
- [Run lifecycle](docs/run-lifecycle.md): per-run options, supersede and
  queue, abort, boot and initialization.
- [Threat model](docs/threat-model.md): the security goal, what is in
  and out of scope, each capability's attack surface.
- [Proxy protocol](docs/proxy-protocol.md): how `FetchCapability` talks to
  a CORS proxy, and what a proxy must do.
- [Architecture](docs/architecture.md): entry points, source layout, and
  the function of the worker boundary.
- [Development](docs/development.md): build, test, lint, release.
- [Writing style](docs/writing-style.md): the ASD-STE100 rules for docs
  and comments.
- [Live demo](https://nickbreaks.github.io/tethered/): a small vanilla TS
  playground ([source](demo/main.ts), `npm run dev:demo`).

## Contributing

Report bugs and send pull requests on
[GitHub](https://github.com/NickBreaks/tethered/issues). Read
[CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[MIT](LICENSE)
