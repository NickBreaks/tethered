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

`npm run build` uses `tsc` to make `dist/`: ES modules and declarations for
`.` and `./workers`. It also uses esbuild to bundle `src/js-worker.ts` into
one self-contained file. Then `scripts/verify-build.mjs` makes sure that the
core does not import a worker module, directly or through other modules.
It also makes sure that no
declaration file names the engine.

## How it fits together

- **Runners** implement `CodeRunner`: the `ready`, `isRunning` and
  `initError` values, and `initialize()`, `execute(code, options)` and
  `abort()`. The built-in `JsRunner` runs code in a dedicated worker.
  `abort()` and the timeout backstop terminate the worker and start a new
  one. Thus, every run stops.
- **The worker boundary.** The main thread and the worker send messages
  with a small protocol (`JsMainToWorkerMsg` / `JsWorkerToMainMsg`).
  `JsRunner` does not trust the worker. It checks the shape of every
  message, and ignores unknown or malformed messages. It sends replies
  only to the worker and run that asked.
- **Capabilities cross the boundary by RPC.** Capabilities with a host
  backend (fetch, storage, disk, your own) implement
  `invokeHost(method, args)`. They keep their backends and the proxy token
  on the main thread. A guest call suspends the engine. The worker sends
  the call as a `cap-call`, and the engine continues when the
  `cap-result` comes back. The timer globals are part of the worker.
  `TimerCapability` only switches them on or off.
- **`RuntimeFacade`** takes a map of runners
  (`Record<string, CodeRunner>`). It owns the active mode and the output
  log. It sends each call to the runner for the active mode.
- **The engine is hidden.** The worker runs QuickJS compiled to
  WebAssembly. But no public type names the engine, and the core does not
  import it. Thus, you can replace the engine without an API change.

## Design rules

- The core (`src/index.ts`, `src/lib/`) imports no package and no worker
  module. ESLint, `src/lib/core-import-guard.spec.ts` and
  `scripts/verify-build.mjs` enforce this rule.
- `src/workers/` imports the core only through `src/index.ts`.
- No emitted `.d.ts` mentions the engine.
