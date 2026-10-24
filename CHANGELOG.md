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
- Host calls look synchronous to the guest. They also work with `await`,
  in promise jobs and in timer callbacks.
- The host does not trust the worker. It checks the shape of every
  message. It answers host calls only for enabled capabilities and
  declared methods. It sends replies only to the worker and run that
  asked.
- `RuntimeFacade` with a pluggable runner map (`runners` option).
- Capabilities:
  - `FetchCapability`: direct or through a CORS proxy, with optional
    `allowHosts` / `denyHosts` and a body size limit
    (`maxResponseBytes`).
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
