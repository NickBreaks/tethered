# Usage

## Entry points

| Import | What it is |
| --- | --- |
| `tethered` | The core: `createSandboxRuntime`, `JsRunner`, `RuntimeFacade`, `CapabilityStore`, the built-in capabilities, `ProxyAuth`, types. No dependencies, no worker code. |
| `tethered/workers` | Default worker factories: `defaultJsWorkerFactory`, `createJsWorkerFactory({ allowInProcess })`, and `InProcessJsWorker` for jsdom/SSR tests. |
| `tethered/js-worker` | The worker script, as one self-contained ES module. It includes the engine and the WASM. |

The core never starts a worker itself. You must give it a factory. Use one
of the two subsequent procedures.

## Spawning the worker

**Your bundler emits the worker file (recommended).** Import the worker
script as a URL. Then build the factory yourself. The bundle does not
include parts of `tethered/workers`.

```ts
// Vite
import jsWorkerUrl from 'tethered/js-worker?url';
const jsWorkerFactory = () => new Worker(jsWorkerUrl, { type: 'module' });
```

Other bundlers have their own procedure to emit a file and import its URL
(for example, the esbuild `file` loader). If you do not use a bundler, copy
`node_modules/tethered/dist/js-worker.js` to the directory of your page.
Then give its URL to the factory.

**The default factory.** `defaultJsWorkerFactory` from `tethered/workers`
starts `new Worker(new URL('../js-worker.js', import.meta.url), { type: 'module' })`.
This works in ES modules that are not bundled. It also works with bundlers
that follow `new URL(…, import.meta.url)` inside dependencies. The Vite
pre-bundle step for dependencies breaks the relative URL. Thus, with Vite,
use the `?url` import.

**Tests without `Worker`.** In jsdom or Node, `defaultJsWorkerFactory`
throws. Thus, `initialize()` rejects. Opt in to the in-process host:

```ts
import { createJsWorkerFactory } from 'tethered/workers';
const jsWorkerFactory = createJsWorkerFactory({ allowInProcess: true });
```

It runs the same engine on the calling thread. It has no isolation and it
cannot interrupt a busy loop. Thus, use it only for tests. The
[threat model](threat-model.md) does not include it.

## Running code

```ts
import { createSandboxRuntime } from 'tethered';

const rt = createSandboxRuntime({ jsWorkerFactory, timeoutMs: 5000 });
await rt.js.initialize();

const result = await rt.facade.execute('console.log("hi"); 6 * 7', { tag: 'demo' });
// result: { success, output: OutputEntry[], error?, timedOut, durationMs }

await rt.js.abort(); // stops the run in flight, also a hot loop
rt.dispose();        // terminates the worker, removes subscribers
```

Guest code is a script, not a module. Thus, you cannot use `import` or a
top-level `await`. To the guest, host calls through capabilities (for
example, `fetch`) look synchronous. The worker suspends the engine until
the host answers. This is also true in a promise job (for example, after
`await` or in `.then()`) and in a timer callback.

A host call cannot suspend the engine inside a function that the host
calls synchronously. An example is `toJSON()` while `console.log` reads
its argument. There, the host call throws an error in the guest. After
the time limit, a host call does not start, and the run times out.

After the script, the worker runs all promise jobs, also when the `timer`
capability is disabled. If the value of the script is a promise, the
result is the value of that promise when it settles. Thus, an async IIFE
such as `(async () => { … })()` gives its return value. If the promise
rejects, the run fails with that error. A promise that can never settle
gives no result entry.

`OutputEntry.type` is `'log'`, `'warn'`, `'error'`, `'result'` or
`'system'`. The guest controls the string in each `content`. Render it as
text. Do not render it as HTML.

For overlapping runs, the queue, the options for each run and boot
failures, refer to [run lifecycle](run-lifecycle.md).

## Capabilities

A capability is the only path from guest code to the host. Register the
capability, then enable it. The runner reads the set of enabled
capabilities when each run starts. The host checks the set again on every
host call.

```ts
import {
  FetchCapability,
  StorageCapability,
  DiskCapability,
  TimerCapability,
} from 'tethered';

rt.registry.register(new TimerCapability());               // setTimeout and related functions, in the worker
rt.registry.register(new StorageCapability());             // storage.getItem/setItem/removeItem
rt.registry.register(new DiskCapability());                // disk.readFile/writeFile/listFiles
rt.registry.register(
  new FetchCapability(rt.auth, { allowHosts: ['api.example.com', '*.example.org'] }),
);
rt.registry.setEnabled('timer', true);
rt.registry.setEnabled('fetch', true);
```

- **fetch**: `allowHosts` / `denyHosts` limit the destinations. First,
  read the fetch section of the [threat model](threat-model.md).
  `maxResponseBytes` limits the size of a response body (default 10 MiB).
  The guest can use the response directly (`fetch(u).json()`), with
  `await`, or with `.then()`.
  Cross-origin requests can go through a CORS proxy (`corsProxyUrl`).
  Refer to the [proxy protocol](proxy-protocol.md).
- **storage**: the `localStorage` of the page, under a fixed key prefix.
  To change this, give your own backend (`getItem`/`setItem`/`removeItem`).
- **disk**: by default, a virtual file system in IndexedDB. You can give a
  `MapDiskBackend` or your own `DiskBackend`. Paths are absolute keys.
  The capability resolves `.` and `..` (`normalizePath`), and `..` never
  goes above `/`. `IndexedDBDiskBackend` keeps one connection open. Call
  its `close()` to release it.
- **timer**: guest timers run on virtual time inside the worker. The
  clock starts at 0 for each run, and moves forward to the next due
  timer. No real time passes. The worker drains the timers before the
  run settles.

Your own capability implements `SandboxCapability`:

- a `name`;
- a `description`;
- a `stubInfo` that describes the guest functions to install;
- `invokeHost(method, args)` on the main thread.

The guest chooses the `args` values. Validate them. The guest can do all
that `invokeHost` allows.

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

`RuntimeFacade` sends calls to a map of runners, with one key for each
mode. `js` is built in. You can add any object that implements
`CodeRunner`:

```ts
const rt = createSandboxRuntime({ jsWorkerFactory, runners: { notes: myRunner } });
rt.facade.setMode('notes'); // aborts the JS run; an unknown key throws an error
rt.dispose();               // you must dispose extra runners yourself
```

The security claim does not include extra runners.

## Reactive state

State such as `rt.facade.ready`, `isRunning`, `initError`, `mode` and
`output` is a `ReadableValue<T>`:

- `get()` returns the current value synchronously;
- `subscribe(fn)` calls `fn` on each subsequent change (compared with
  `Object.is`). It does not call `fn` when you subscribe. It returns an
  unsubscribe function.

You can use it directly with `useSyncExternalStore`. To connect it to a
framework signal or store, it is necessary to add only a few lines
of glue code.
