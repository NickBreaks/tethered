# Changelog

This file lists all important changes to this project. tethered follows
[Semantic Versioning](https://semver.org/) with the 0.x rule: a minor
release can break the API, and a patch release does not.

## 0.2.0

Security and correctness fixes. Some changes break the API.

Security:

- A guest can no longer make the runner run its code a second time. The
  worker reports heap exhaustion with an `exhausted` flag on `done`, from
  signals that the guest cannot make. The runner does not examine the
  error text.
- A guest can no longer cause a false timeout. A run times out only when
  the interrupt handler stops it.
- `FetchCapability` reads response bodies with a limit
  (`maxResponseBytes`, default 10 MiB). `cleanup()` aborts the requests
  in flight when a run ends.
- A proxy base with a trailing slash (for example `'/'`) no longer makes
  a protocol-relative URL. Such a URL could send the token to a different
  host.
- The guest URL is resolved once, against `document.baseURI`. The host
  policy, the route and the request all use that URL.

Fixes:

- `await fetch(...)` and `.then()` chains on the response complete.
- Host calls (fetch, storage, disk) work in promise jobs and in timer
  callbacks. Where a host call cannot suspend the engine, the guest gets
  an error. The run does not stay pending.
- Promise jobs run after every script, also without the timer
  capability. A settled top-level promise gives its value or its error.
- Timers created by top-level code and timers created later use one
  virtual clock. Thus they fire in the correct sequence.
- `normalizePath` resolves `.` and `..` segments.
- The disk database has only the `files` store, at version 1. The
  unused `write_journal` store is removed.

Breaking changes:

- `timeoutMs` and `bootTimeoutMs` must be finite, larger than 0, and
  small enough for `setTimeout`. Incorrect values throw a `RangeError`.
  An incorrect per-run `timeoutMs` gives a failed result.
- A real out-of-memory error at the memory limit is not run again.
- `quickjs-emscripten-core` and the asyncify variant are pinned to
  exactly 0.32.0.

## 0.1.1

- Docs and code comments follow ASD-STE100 (Simplified Technical
  English). There is no change to the API or to behavior.

## 0.1.0

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
- The host does not trust the worker. It checks the shape of every
  message. It answers host calls only for enabled capabilities and
  declared methods. It sends replies only to the worker and run that
  asked.
- `RuntimeFacade` with a pluggable runner map (`runners` option).
- Capabilities: `FetchCapability` (direct or through a CORS proxy, with
  optional `allowHosts` / `denyHosts`), `StorageCapability`,
  `DiskCapability` (IndexedDB or in-memory), `TimerCapability`, and the
  `SandboxCapability` interface for your own.
- Entry points:
  - `tethered`: the core, with no dependencies;
  - `tethered/workers`: default worker factories, and an opt-in
    in-process host for tests;
  - `tethered/js-worker`: the self-contained worker script.
- Docs: threat model, proxy protocol, run lifecycle.
