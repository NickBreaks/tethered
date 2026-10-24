# Run lifecycle

This page tells about:

- the options for each run;
- the state of the run in flight;
- how output streams;
- the JS runner options for the queue and for worker replacement;
- how runners boot.

## Every runner (`CodeRunner`)

| Member | What it does |
| --- | --- |
| `execute(code, { timeoutMs?, tag? })` | `timeoutMs` overrides the `timeoutMs` of the runner for this run only. `tag` (default `''`) names the caller. `facade.execute` / `facade.run` send the same options to the runner. |
| `activeTag: ReadableValue<string \| null>` | The tag of the run in flight. It is `null` between runs. Host capabilities can read it inside `invokeHost()` to find who started the run. |
| `onOutput(fn) => unsubscribe` | The runner calls `fn` for each entry when it adds the entry to the `output` of a started run. Thus, `fn` gets the same entries as the result, in the same order. |

The JS runner accepts a time limit only if it is a finite number greater
than 0 and at most 2147481647 ms. The backstop adds 2000 ms, and the sum
must fit in a `setTimeout` delay. These rules apply to:

- the `timeoutMs` option of the constructor and of `createSandboxRuntime()`
  (else it throws a `RangeError`);
- the `timeoutMs` property of the runner (else the setter throws a
  `RangeError`, and the old value stays);
- the `timeoutMs` option of `execute()`. Else the run settles at once
  with `success: false`, `timedOut: false` and the rule as `error`. That
  run does not start, and the run in flight continues. `execute()` never
  rejects.

`bootTimeoutMs` must be a finite number greater than 0 and at most
2147483647 ms. Else the constructor throws a `RangeError`.

How each runner streams output:

- **JS**: first, the `[… enabled]` system entry when the run starts.
  Then each `console.*` entry when the worker posts it. Last, the
  result/error entry. The runner also streams abort and timeout entries.
- **Your own runners** (registered through `runners`) stream output as
  their `onOutput` implementation does.

## JS runner options

Give these options to `new JsRunner(registry, { … })`, or give them at
the top level to `createSandboxRuntime()`:

| `JsRunnerOptions` | `createSandboxRuntime` | Default | Effect |
| --- | --- | --- | --- |
| `concurrency` | `jsConcurrency` | `'supersede'` | `'supersede'`: an overlapping run replaces the current run, on a fresh worker (refer to the subsequent text). `'queue'`: each run starts after all earlier runs settle (finish, fail, time out or abort). |
| `recycleAfterRuns` | `jsRecycleAfterRuns` | off | After N runs on one worker, the next run first replaces the worker. |
| `recoverExhaustion` | `jsRecoverExhaustion` | `true` | If the worker reports that its heap is spent (refer to the subsequent text), the runner replaces the worker and tries the run one more time. If the second try fails in the same way, the runner replaces the worker again and returns that failure. |

**Spent heap.** The worker sets the `exhausted` flag of its `done`
message only for signals that the guest cannot forge:

- the engine runtime, its context or a capability setup fails before the
  guest code starts;
- the run fails with an out-of-memory error, and after the run the worker
  cannot start a fresh engine.

The error text alone never causes a retry. Thus a guest that throws
`new Error('out of memory')` or overflows its stack does not run two
times.

JS-only subscriptions and state:

- `onRun(fn)`: gets `{ tag, startTime, timeoutMs }` when a run starts,
  and `null` when it ends (finished, timed out or aborted). A second try
  after memory exhaustion gives a second start/end pair.
- `onRecycle(fn)`: when the runner replaces the worker, it calls `fn` with
  `'periodic'` (`recycleAfterRuns`) or with the error message of the run
  (exhaustion). When abort or a timeout starts a new worker, the runner
  does not call `fn`.
- `queued: ReadableValue<number>`: the number of runs that wait after the
  run in flight. It is always 0 in `'supersede'` mode.

`abort()` stops only the run in flight. In `'queue'` mode, the queued runs
then start on the new worker.

**Supersede.** An `execute()` that overlaps a run settles the older run
immediately. The older run gets `success: false`, `timedOut: false` and
`error: 'Execution superseded by a newer run.'`. Its output is the output
until that time, plus that system entry. The runner clears the backstop of
the older run and cleans up its capabilities. `onRun(null)` fires for the
older run before the new run starts.

Then the runner terminates the worker and starts a new worker. While the
new worker boots, `ready` is `false`, `isRunning` stays `true`, and
`activeTag` is `null`. The runner sets the tag only when it posts the new
run. The new run starts on the fresh worker. This also releases a worker
that is stuck in a hot loop. It also releases a worker that is suspended
on a host call that never returns. The engine allows only one suspension
at a time. Thus, the old worker cannot do the host calls of the new run.

The runner ignores late messages from the old worker or for the old run.
It never sends the answer to a pending host call of the old run into the
new run. If a newer run supersedes an `execute()` while the fresh worker
boots, that `execute()` settles in the same way, and never starts. Use
`'queue'` when callers can overlap and each run must finish.

## Initialization

`initialize()` on the JS runner uses the factory that you give to start
the worker. It resolves when the worker posts a valid `ready`. It rejects
when the worker does not start:

- the factory throws;
- the worker fires `error` (for example, the browser did not load the
  script);
- the worker posts an init error;
- no `ready` arrives within `bootTimeoutMs` (`JsRunner`) /
  `jsBootTimeoutMs` (`createSandboxRuntime`), default 30000 ms.

The runner also keeps the message in `initError`, and terminates the
failed worker. A later `initialize()` starts a fresh worker. If you call
`dispose()` during a boot, it clears the boot timer. Then the pending
`initialize()` resolves, as it does on a disposed runner. Callers that do
not wait for the result must still catch the rejection.

**No in-process fallback by default.** If there is no global `Worker`
(jsdom, SSR), `defaultJsWorkerFactory` throws. Then `initialize()` rejects
with a message that names `allowInProcess`. If a test must have the real
engine there, it can opt in with
`createJsWorkerFactory({ allowInProcess: true })` from `tethered/workers`.
This runs the same worker code on the calling thread. That mode has no
isolation, and the [threat model](threat-model.md) does not include it.
If `Worker` is available, the runner always uses a real worker.

**Lazy init through the facade.** `RuntimeFacade.setMode(key)` calls
`initialize()` on a runner that is not ready. It does not do this if an
`initialize()` call from the facade is in flight or was successful. A
failure (rejection or synchronous throw) never goes out of `setMode()`.
The `initError` of the facade shows the failure until the runner is
ready. The next change to that mode tries again. The facade never
initializes the runner of the initial mode. Boot it yourself
(`await rt.js.initialize()`).

**Superseding respawns.** In `'supersede'` mode, each superseded run
causes a worker boot (refer to the text above). Thus, the boot timeout and
`initError` also apply to the fresh worker. If the fresh worker does not
boot, the new run settles as not initialized, and `isRunning` clears.
