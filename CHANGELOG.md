# Changelog

All notable changes to this project are listed here. tethered follows
[Semantic Versioning](https://semver.org/) with the 0.x rule: a minor
release may break the API, a patch release does not.

## 0.1.0

First release.

- `createSandboxRuntime()`: a capability registry, proxy auth, the JS
  runner and a `RuntimeFacade`, wired together without side effects.
- `JsRunner`: runs guest JavaScript in a sandboxed engine (WebAssembly)
  inside a dedicated Web Worker. Per-run time limit with a main-thread
  backstop, per-run memory limit, boot timeout, `abort()` that stops hot
  loops, `'supersede'` (default) or `'queue'` concurrency, periodic
  worker recycling and heap-exhaustion recovery.
- The worker is treated as untrusted: every message is shape-checked,
  host calls are answered only for enabled capabilities and declared
  methods, and replies go only to the worker and run that asked.
- `RuntimeFacade` with a pluggable runner map (`runners` option).
- Capabilities: `FetchCapability` (direct or through a CORS proxy, with
  optional `allowHosts` / `denyHosts`), `StorageCapability`,
  `DiskCapability` (IndexedDB or in-memory), `TimerCapability`, and the
  `SandboxCapability` interface for your own.
- Entry points: `tethered` (core, no dependencies), `tethered/workers`
  (default worker factories, opt-in in-process host for tests) and
  `tethered/js-worker` (the self-contained worker script).
- Docs: threat model, proxy protocol, run lifecycle.
