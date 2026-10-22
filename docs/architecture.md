# Architecture

## Source layout

```
src/
  index.ts                    core entry (`tethered`): framework-free, no dependencies
  lib/
    create-sandbox-runtime.ts createSandboxRuntime(): wires everything, no side effects
    runtime-facade.ts         RuntimeFacade: owns the mode and the output log, picks a runner
    shared/                   ReadableValue, CodeRunner, result types, serialize
    js/                       JsRunner, the worker protocol and its message checks
    proxy/                    ProxyAuth: owns the proxy token (sessionStorage only)
    capabilities/             CapabilityStore and the fetch / storage / disk / timer capabilities
  workers/                    `tethered/workers` entry
    index.ts
    default-worker-factories.ts
    in-process-worker.ts      Worker-shaped shim for jsdom/SSR tests (opt-in)
    worker-host.ts            the engine host that runs inside the worker
    capability-bridge.ts      installs the guest functions for each capability
    guest-timers.ts           setTimeout & co. on virtual time, inside the worker
  js-worker.ts                the worker script, bundled into dist/js-worker.js
```

`npm run build` emits `dist/` with `tsc` (ES modules and declarations for
`.` and `./workers`) and bundles `src/js-worker.ts` with esbuild into one
self-contained file. `scripts/verify-build.mjs` then checks that the core
reaches no worker module and that no declaration file names the engine.

## How it fits together

- **Runners** implement `CodeRunner`: `ready`, `isRunning` and
  `initError` values plus `initialize()`, `execute(code, options)` and
  `abort()`. The built-in `JsRunner` runs code in a dedicated worker;
  `abort()` and the timeout backstop terminate the worker and spawn a new
  one, so any run stops.
- **The worker boundary.** The main thread and the worker exchange a
  small message protocol (`JsMainToWorkerMsg` / `JsWorkerToMainMsg`).
  `JsRunner` treats the worker as untrusted: every message is
  shape-checked, unknown or malformed ones are dropped, and replies go
  only to the worker and run that asked.
- **Capabilities cross the boundary by RPC.** Host-backed capabilities
  (fetch, storage, disk, your own) implement `invokeHost(method, args)`
  and keep their backends, and the proxy token, on the main thread. A
  guest call suspends the engine, is relayed as a `cap-call`, and resumes
  with the `cap-result`. The timer globals are built into the worker;
  `TimerCapability` is only their switch.
- **`RuntimeFacade`** takes a runner map (`Record<string, CodeRunner>`),
  owns the active mode and the output log, and delegates to the runner
  under that key.
- **The engine is hidden.** The worker runs QuickJS compiled to
  WebAssembly, but no public type names it and the core does not import
  it. It can be replaced without an API change.

## Design rules

- The core (`src/index.ts`, `src/lib/`) imports no package and no worker
  module. ESLint, `src/lib/core-import-guard.spec.ts` and
  `scripts/verify-build.mjs` enforce it.
- `src/workers/` imports the core only through `src/index.ts`.
- No emitted `.d.ts` mentions the engine.
