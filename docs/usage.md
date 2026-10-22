# Usage

## Entry points

| Import | What it is |
| --- | --- |
| `tethered` | The core: `createSandboxRuntime`, `JsRunner`, `RuntimeFacade`, `CapabilityStore`, the built-in capabilities, `ProxyAuth`, types. No dependencies, no worker code. |
| `tethered/workers` | Default worker factories: `defaultJsWorkerFactory`, `createJsWorkerFactory({ allowInProcess })`, and `InProcessJsWorker` for jsdom/SSR tests. |
| `tethered/js-worker` | The worker script itself, one self-contained ES module (engine and WASM included). |

The core never spawns a worker on its own: you pass a factory. Pick one
of the two below.

## Spawning the worker

**Your bundler emits the worker file (recommended).** Import the worker
script as a URL and build the factory yourself. Nothing from
`tethered/workers` is bundled.

```ts
// Vite
import jsWorkerUrl from 'tethered/js-worker?url';
const jsWorkerFactory = () => new Worker(jsWorkerUrl, { type: 'module' });
```

Other bundlers have their own way to emit a file and import its URL
(for example esbuild's `file` loader). Without a bundler, copy
`node_modules/tethered/dist/js-worker.js` next to your page and pass its
URL.

**The default factory.** `defaultJsWorkerFactory` from `tethered/workers`
spawns `new Worker(new URL('../js-worker.js', import.meta.url), { type: 'module' })`.
That works in unbundled ES modules and with bundlers that follow
`new URL(…, import.meta.url)` inside dependencies. Vite's dependency
pre-bundling breaks the relative URL, so use the `?url` import there.

**Tests without `Worker`.** In jsdom or Node, `defaultJsWorkerFactory`
throws, so `initialize()` rejects. Opt in to the in-process host:

```ts
import { createJsWorkerFactory } from 'tethered/workers';
const jsWorkerFactory = createJsWorkerFactory({ allowInProcess: true });
```

It runs the same engine on the calling thread. It has no isolation and
cannot interrupt a busy loop, so it is for tests only and outside the
[threat model](threat-model.md).

## Running code

```ts
import { createSandboxRuntime } from 'tethered';

const rt = createSandboxRuntime({ jsWorkerFactory, timeoutMs: 5000 });
await rt.js.initialize();

const result = await rt.facade.execute('console.log("hi"); 6 * 7', { tag: 'demo' });
// result: { success, output: OutputEntry[], error?, timedOut, durationMs }

await rt.js.abort(); // stops the run in flight, even a hot loop
rt.dispose();        // terminates the worker, drops subscribers
```

Guest code is a script, not a module: no `import`, no top-level `await`.
Host calls made through capabilities (such as `fetch`) look synchronous
to the guest; the worker suspends the engine until the host answers.

`OutputEntry.type` is `'log'`, `'warn'`, `'error'`, `'result'` or
`'system'`. Every `content` is a guest-controlled string: render it as
text, never as HTML.

Overlapping runs, queueing, per-run options and boot failures are covered
in [run lifecycle](run-lifecycle.md).

## Capabilities

A capability is the only way guest code reaches the host. Register it,
then enable it; the enabled set is read when each run starts and checked
again on every host call.

```ts
import {
  FetchCapability,
  StorageCapability,
  DiskCapability,
  TimerCapability,
} from 'tethered';

rt.registry.register(new TimerCapability());               // setTimeout & co., in-worker
rt.registry.register(new StorageCapability());             // storage.getItem/setItem/removeItem
rt.registry.register(new DiskCapability());                // disk.readFile/writeFile/listFiles
rt.registry.register(
  new FetchCapability(rt.auth, { allowHosts: ['api.example.com', '*.example.org'] }),
);
rt.registry.setEnabled('timer', true);
rt.registry.setEnabled('fetch', true);
```

- **fetch**: `allowHosts` / `denyHosts` limit the destinations; read the
  fetch section of the [threat model](threat-model.md) first. Cross-origin
  requests can go through a CORS proxy (`corsProxyUrl`), see the
  [proxy protocol](proxy-protocol.md).
- **storage**: the page's `localStorage`, under a fixed key prefix; pass
  your own backend (`getItem`/`setItem`/`removeItem`) to change that.
- **disk**: an IndexedDB-backed virtual file system by default; pass a
  `MapDiskBackend` or your own `DiskBackend`.
- **timer**: guest timers run on virtual time inside the worker and are
  drained before the run settles.

Your own capability implements `SandboxCapability`: a `name`, a
`description`, a `stubInfo` describing the guest functions to install,
and `invokeHost(method, args)` on the main thread. `args` are
guest-chosen values: validate them. Whatever `invokeHost` allows, the
guest can do.

```ts
import type { SandboxCapability } from 'tethered';

const clock: SandboxCapability = {
  name: 'clock',
  description: 'Reads the host clock',
  stubInfo: { name: 'now', type: 'function' },
  invokeHost: async () => Date.now(),
};
rt.registry.register(clock);
rt.registry.setEnabled('clock', true);
await rt.facade.execute('now()');
```

## Extra runners

`RuntimeFacade` dispatches to a map of runners keyed by mode; `js` is
built in. Any object implementing `CodeRunner` can be added:

```ts
const rt = createSandboxRuntime({ jsWorkerFactory, runners: { notes: myRunner } });
rt.facade.setMode('notes'); // aborts the JS run; an unknown key throws
rt.dispose();               // extra runners are yours to dispose
```

Extra runners are outside the security claim.

## Reactive state

State such as `rt.facade.ready`, `isRunning`, `initError`, `mode` and
`output` is a `ReadableValue<T>`:

- `get()` returns the current value synchronously;
- `subscribe(fn)` calls `fn` on every later change (compared with
  `Object.is`), never on subscribe, and returns an unsubscribe function.

That fits `useSyncExternalStore` directly, and a framework signal or
store with a few lines of glue.
