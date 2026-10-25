# Changelog

This file lists all important changes to this project. tethered follows
[Semantic Versioning](https://semver.org/) with the 0.x rule: a minor
release can break the API, and a patch release does not.

## 0.1.0 (not released)

First release.

- `createSandboxRuntime()`: connects a capability registry, proxy auth,
  the JS runner and a `RuntimeFacade`, without side effects.
- `JsRunner`: runs guest JavaScript in a sandboxed engine (WebAssembly)
  inside a dedicated Web Worker. It has:
  - a time limit for each run, with a backstop on the main thread;
  - a memory limit for each run;
  - a boot timeout;
  - an `abort()` that stops hot loops;
  - `'supersede'` (default) or `'queue'` concurrency;
  - periodic replacement of the worker;
  - recovery when the heap has no more memory.
- Limits on host memory, outside the memory limit of the engine:
  - an output limit for each run (`maxOutputChars`, default 1048576
    characters). Each entry costs its characters plus a fixed cost of 64
    characters, thus empty entries also count. The runner drops the
    output after the limit. The worker also stops its posts at the limit.
  - a maximum of 10000 pending guest timers for each run. A clear
    removes its timer at once.
  - a maximum of 10000 characters for the `error` of each run. The
    worker and the runner both apply it. The runner keeps a copy of the
    characters, thus the full error string does not stay in host memory.
- Host calls look synchronous to the guest. They also work with `await`,
  in promise jobs and in timer callbacks.
- The host does not trust the worker. It checks the shape of every
  message. It answers host calls only for declared methods of the
  capabilities that were enabled when the run started. It sends replies only to the worker and run that
  asked.
- `RuntimeFacade` with a pluggable runner map (`runners` option).
- Capabilities:
  - `FetchCapability`: direct or through a CORS proxy, with optional
    `allowHosts` / `denyHosts` and a body size limit
    (`maxResponseBytes`).
  - `ProxyAuth.setToken` accepts only visible ASCII characters, so the
    token is always a valid header value.
  - `StorageCapability`, with `LocalStorageBackend` (default) or
    `MapStorageBackend`.
  - `DiskCapability`, with `IndexedDBDiskBackend` (default) or
    `MapDiskBackend`.
  - `TimerCapability`: guest timers on a virtual clock.
  - The `SandboxCapability` interface for your own capabilities.
- Entry points:
  - `tethered`: the core, with no dependencies;
  - `tethered/workers`: default worker factories, and an opt-in
    in-process host for tests;
  - `tethered/js-worker`: the self-contained worker script.
- Docs: threat model, proxy protocol, run lifecycle.
