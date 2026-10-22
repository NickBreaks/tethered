# Run lifecycle

Per-run options, run-in-flight state, output streaming, the JS runner's
queueing and worker-recycling options, and how runners boot.

## Every runner (`CodeRunner`)

| Member | What it does |
| --- | --- |
| `execute(code, { timeoutMs?, tag? })` | `timeoutMs` overrides the runner's `timeoutMs` for this run only. `tag` (default `''`) names the caller. `facade.execute` / `facade.run` forward the same options. |
| `activeTag: ReadableValue<string \| null>` | The tag of the run in flight, `null` between runs. Host capabilities can read it inside `invokeHost()` to tell who started the run. |
| `onOutput(fn) => unsubscribe` | Called for each entry as it is appended to a started run's `output`, so it sees the same entries, in the same order, as the result. |

How each runner streams:

- **JS**: the `[… enabled]` system entry when the run starts, each
  `console.*` entry as the worker posts it, and the result/error entry
  last. Abort and timeout entries are streamed too.
- **Your own runners** (registered through `runners`) stream however
  they implement `onOutput`.

## JS runner options

Pass these to `new JsRunner(registry, { … })`, or flat to
`createSandboxRuntime()`:

| `JsRunnerOptions` | `createSandboxRuntime` | Default | Effect |
| --- | --- | --- | --- |
| `concurrency` | `jsConcurrency` | `'supersede'` | `'supersede'`: an overlapping run takes over on a fresh worker (see below). `'queue'`: each run starts after every earlier one has settled (finished, failed, timed out or aborted). |
| `recycleAfterRuns` | `jsRecycleAfterRuns` | off | After N runs on one worker, the next run first replaces the worker. |
| `recoverExhaustion` | `jsRecoverExhaustion` | `true` | A run that fails with `/out of memory\|setup failed\|InternalError/i` (not a timeout) replaces the worker and is retried once. If the retry fails the same way, the worker is replaced again and that failure is returned. |

JS-only subscriptions and state:

- `onRun(fn)`: `{ tag, startTime, timeoutMs }` when a run starts, `null`
  when it ends (finished, timed out or aborted). An exhaustion retry
  reports a second start/end pair.
- `onRecycle(fn)`: called with `'periodic'` (`recycleAfterRuns`) or the
  run's error message (exhaustion) when the worker is replaced. Abort and
  timeout respawns do not fire it.
- `queued: ReadableValue<number>`: runs waiting behind the one in flight
  (always 0 in `'supersede'` mode).

`abort()` stops only the run in flight. In `'queue'` mode, queued runs
then start on the respawned worker.

**Supersede.** An `execute()` that overlaps a run settles the older run
at once with `success: false`, `timedOut: false` and
`error: 'Execution superseded by a newer run.'`, with its output so far
plus that system entry. Its backstop is cleared, its capabilities are
cleaned up, and `onRun(null)` fires for it before the new run's start.
Its worker is then terminated and respawned (`ready` is `false` while the
new one boots, `isRunning` stays `true` and `activeTag` is `null`, since
the tag is set only once the new run is posted), and the new run starts
on the fresh worker. That also frees a worker stuck in a hot loop or suspended
on a host call that never returns: the engine allows one suspension at a
time, so the old worker could not serve the new run's host calls. Late
messages from the old worker or for the old run are ignored, and a host
call still pending for the old run is never answered into the new one.
An `execute()` that is itself superseded while the fresh worker boots
settles the same way without ever starting. Use `'queue'` when callers
can overlap and each run must finish.

## Initialization

`initialize()` on the JS runner spawns the worker through the factory you
pass and resolves once the worker posts a valid `ready`. It rejects when
the worker fails to start:

- the factory throws;
- the worker fires `error` (for example, the browser refused to load the
  script);
- the worker posts an init error;
- no `ready` arrives within `bootTimeoutMs` (`JsRunner`) /
  `jsBootTimeoutMs` (`createSandboxRuntime`), default 30000 ms.

The message is also left in `initError`, the failed worker is terminated,
and a later `initialize()` spawns a fresh one. `dispose()` during a boot
clears the boot timer, and the pending `initialize()` resolves, as it does
on a disposed runner. Fire-and-forget callers should still catch the
rejection.

**No in-process fallback by default.** Without a global `Worker` (jsdom,
SSR), `defaultJsWorkerFactory` throws, so `initialize()` rejects with a
message naming `allowInProcess`. Tests that need the real engine there opt
in with `createJsWorkerFactory({ allowInProcess: true })` from
`tethered/workers`, which runs the same worker code on the calling thread. That
mode has no isolation and is outside the
[threat model](threat-model.md). With `Worker` present a real worker is
always used.

**Lazy init through the facade.** `RuntimeFacade.setMode(key)` calls
`initialize()` on a runner that is not ready, unless a facade-started
call is in flight or has succeeded. A failure (rejection or synchronous
throw) never escapes `setMode()`: it shows in the facade's `initError`
until the runner becomes ready, and the next switch to that mode retries.
The facade never initializes the initial mode's runner; boot it yourself
(`await rt.js.initialize()`).

**Superseding respawns.** In `'supersede'` mode each superseded run costs
a worker boot (see above), so the boot timeout and `initError` also apply
to the fresh worker: if it fails to boot, the new run settles as not
initialized and `isRunning` clears.
