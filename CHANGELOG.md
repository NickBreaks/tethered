# Changelog

This file lists all important changes to this project. tethered follows
[Semantic Versioning](https://semver.org/) with the 0.x rule: a minor
release can break the API, and a patch release does not.

## 0.1.1 (2026-10-27)

First release on npm. Version 0.1.0 was not published.

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
  - recovery when the heap has no more memory, and when the engine fails
    to free a runtime (for example after a stack overflow). For a
    failed free, the worker refuses all later runs, and the runner
    replaces the worker. It does not retry the run.
  - a full free of the runtime after each run. quickjs-emscripten-core
    0.32.0 deletes the callbacks of an async runtime before it frees the
    runtime. Then the free fails, and each run leaks its runtime in the
    WASM heap. The worker changes this order. Thus any error from a free
    now marks the engine as broken.
  - a timeout also while the worker reads the final value or error. A
    guest `toJSON()` that runs until the deadline gives `timedOut: true`,
    not a success.
  - an explicit engine stack limit (`MAX_STACK_SIZE`, 1 MiB). The engine
    already sets this value for a new runtime. Thus the behaviour does
    not change.
- Limits on host memory, outside the memory limit of the engine:
  - an output limit for each run (`maxOutputChars`, default 1048576
    characters). Each entry costs its characters plus a fixed cost of 64
    characters, thus empty entries also count. The runner drops the
    output after the limit. The worker also stops its posts at the limit.
  - a maximum of 10000 pending guest timers for each run. A clear
    removes its timer at once.
  - compact JSON, without indentation, for a `console` argument or a
    result that is nested more than 20 levels deep. Thus the text grows
    linearly with the depth, not with its square.
  - a maximum of 10000 characters for the `error` of each run. The
    worker and the runner both apply it. The runner keeps a copy of the
    characters, thus the full error string does not stay in host memory.
  - a maximum of 16777216 characters (`MAX_HOST_CALL_ARG_CHARS`) for the
    arguments of one host call. A string counts its length, a bigint its
    digits and a symbol its description. Each other value counts the
    length of its engine JSON. The worker measures this JSON before it
    parses it. A call over the limit gets an error that the
    guest can catch, and no message goes to the main thread. The worker
    also examines the deadline before it reads the arguments.
- Host calls look synchronous to the guest. They also work with `await`,
  in promise jobs and in timer callbacks.
- The host does not trust the worker. It checks the shape of every
  message. It answers host calls only for declared methods of the
  capabilities that were enabled when the run started. It sends replies only to the worker and run that
  asked.
- The host replies to each host call of the active run. An error reply
  is a string of 10000 characters or fewer. This also applies to a
  refusal that contains the capability and method names from the worker.
  When the host cannot get a string from the error, the guest gets
  `host call failed`. A host call for a run that ended gets no reply.
- `RuntimeFacade` with a pluggable runner map (`runners` option).
- Capabilities:
  - `FetchCapability`: direct or through a CORS proxy, with optional
    `allowHosts` / `denyHosts` and a body size limit
    (`maxResponseBytes`). The end of a run aborts only the requests of
    that run. The constructor refuses a proxy URL with a user name or a
    password, or a proxy URL that does not parse. The capability examines
    `proxyBase()` again on each proxy call. The errors that the guest
    gets do not show the proxy URL or the token.
  - `ProxyAuth.setToken` accepts only visible ASCII characters, so the
    token is always a valid header value.
  - `StorageCapability`, with `LocalStorageBackend` (default) or
    `MapStorageBackend`.
  - `DiskCapability`, with `IndexedDBDiskBackend` (default) or
    `MapDiskBackend`. `writeFile` and `readFile` refuse a path that
    normalizes to the root `/`.
  - `TimerCapability`: guest timers on a virtual clock.
  - The `SandboxCapability` interface for your own capabilities. Each
    `invokeHost()` call gets a `HostCallContext` with a signal that
    aborts when the run ends.
- Entry points:
  - `tethered`: the core, with no dependencies;
  - `tethered/workers`: default worker factories, and an opt-in
    in-process host for tests;
  - `tethered/js-worker`: the self-contained worker script.
- Docs: threat model, proxy protocol, run lifecycle. The proxy protocol
  makes these rules a MUST:
  - refuse private and internal addresses on the destination and on each
    redirect hop, after DNS resolution;
  - never send a guest `Host`, `Content-Length`, `Transfer-Encoding`,
    `Connection` or other hop-by-hop or forbidden request header;
  - allow only `http` and `https` destinations.
