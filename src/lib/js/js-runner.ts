import { createValue } from '../shared/readable-value.js';
import { createEmitter } from '../shared/emitter.js';
import { copyPrefix } from '../shared/copy-prefix.js';
import type { CapabilityStore } from '../capabilities/capability-store.js';
import type { CapabilityStubInfo, SandboxCapability } from '../capabilities/capability.js';
import type { OutputEntry, ExecutionResult } from '../shared/sandbox-types.js';
import type { CodeRunner, ExecuteOptions } from '../shared/code-runner.js';
import {
  MAX_ERROR_CHARS,
  OUTPUT_ENTRY_COST,
  TIMEOUT_MSG,
  type JsCapabilitySnapshot,
  type JsMainToWorkerMsg,
  type JsWorkerToMainMsg,
} from './worker-protocol.js';
import { checkWorkerMessage } from './check-worker-message.js';

const ABORT_MSG = 'Execution aborted.';
const HOST_CALL_FAILED_MSG = 'host call failed';

/**
 * Returns the message of an error from a host call, as a string of
 * `MAX_ERROR_CHARS` or fewer. The capability can throw any value. Its
 * `message` can be a getter that throws, and `String()` can throw. This
 * function never throws. When it cannot get a string, it returns a fixed
 * message. Thus the runner always has a reply for the guest.
 */
function hostErrorMessage(e: unknown): string {
  try {
    const text = e instanceof Error ? (e.message as unknown) : String(e);
    if (typeof text !== 'string') return HOST_CALL_FAILED_MSG;
    return copyPrefix(text, MAX_ERROR_CHARS);
  } catch {
    return HOST_CALL_FAILED_MSG;
  }
}
const SUPERSEDED_MSG = 'Execution superseded by a newer run.';
const NOT_READY_MSG = 'The JS worker is not ready.';
/** The `onRecycle` reason when the engine of the worker failed to free a runtime. */
const BROKEN_REASON = 'broken';
const outputLimitMsg = (max: number): string =>
  `Output limit reached (${max} characters). The runner dropped the remaining output.`;

/**
 * Grace period added to timeoutMs for the main-thread backstop timer.
 * Usually the worker ends timed-out runs itself, through its interrupt
 * handler. The backstop acts only when the worker cannot end the run. For
 * example, the worker is asyncify-suspended and waits for a capability
 * RPC that never resolves. The runner then terminates and respawns the
 * worker.
 */
const BACKSTOP_GRACE_MS = 2000;

const DEFAULT_BOOT_TIMEOUT_MS = 30_000;

const DEFAULT_MAX_OUTPUT_CHARS = 1_048_576;

/** The largest delay that `setTimeout` accepts. A larger delay fires at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Returns an error message when `value` is not a usable time limit, else
 * null. A time limit must be a finite number greater than 0. With `grace`
 * added, it must also fit in a `setTimeout` delay.
 */
function timeLimitProblem(name: string, value: unknown, grace: number): string | null {
  const max = MAX_TIMER_DELAY_MS - grace;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max) {
    return null;
  }
  return `${name} must be a finite number greater than 0 and at most ${max} (got ${String(value)}).`;
}

function checkTimeLimit(name: string, value: unknown, grace: number): number {
  const problem = timeLimitProblem(name, value, grace);
  if (problem !== null) throw new RangeError(problem);
  return value as number;
}

/** Returns `value` when it is a safe integer greater than 0. Else throws a `RangeError`. */
function checkCount(name: string, value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  throw new RangeError(`${name} must be a safe integer greater than 0 (got ${String(value)}).`);
}

/**
 * The guest functions that the worker installs for a capability. This
 * mirrors the capability bridge. For a function capability: its globals,
 * or else its name. For an object capability: its methods.
 */
function declaredMethods(stub: CapabilityStubInfo): readonly unknown[] {
  const list = stub.type === 'function' ? (stub.globals ?? [stub.name]) : stub.methods;
  return Array.isArray(list) ? list : [];
}

/** A worker `error` event's message; empty when the script failed to load. */
function workerErrorMessage(e: ErrorEvent): string {
  return e.message || 'JS worker failed to load.';
}

export interface JsRunnerOptions {
  /**
   * Starts the JS worker (required). `defaultJsWorkerFactory` from
   * `tethered/workers` starts the bundled worker. Without a global
   * `Worker`, use `createJsWorkerFactory({ allowInProcess: true })`.
   * Vite-style apps can build their own factory on the package's
   * worker-script export (see the README).
   */
  workerFactory: () => Worker;
  /**
   * Per-run time limit (ms). Defaults to 5000. It must be a finite number
   * greater than 0 and at most 2147481647 (the backstop adds 2000 ms, and
   * the sum must fit in a `setTimeout` delay). Else the constructor throws
   * a `RangeError`.
   */
  timeoutMs?: number;
  /**
   * What `execute()` does while a run is in flight. `'supersede'`
   * (default): the older run settles immediately as a failure
   * ("superseded"), and its worker is terminated. The new run starts on a
   * new worker when that worker is ready. This also stops an older run
   * that is stuck in a hot loop or suspended on a host call that never
   * returns. A run superseded before it started settles the same way, and
   * is not posted. `'queue'`: the new run starts after all earlier runs
   * settle (finished, timed out or aborted).
   */
  concurrency?: 'supersede' | 'queue';
  /**
   * Replace the worker between runs after it completes this number of
   * runs. The worker frees the engine runtime of each run. Thus this
   * option is only a guard against slow leaks, for example from the
   * fragmentation of the WASM heap. Off by default.
   */
  recycleAfterRuns?: number;
  /**
   * When the worker reports that its heap is spent, respawn the worker and
   * retry the run once on the fresh one. Only the worker can report this,
   * from signals that the guest cannot forge. The error text of the guest
   * never causes a retry. A run that called `invokeHost()` of a capability
   * is not retried, because a retry does its side effects again. The
   * worker is still replaced. Defaults to `true`.
   */
  recoverExhaustion?: boolean;
  /**
   * How long a new worker can take to report ready (ms). After this time,
   * the worker is terminated and the boot fails as a load error does:
   * `initialize()` rejects and `initError` is set. Defaults to 30000. It
   * must be a finite number greater than 0 and at most 2147483647. Else
   * the constructor throws a `RangeError`.
   */
  bootTimeoutMs?: number;
  /**
   * The output limit of each run, in characters. Each entry costs the
   * characters (UTF-16 code units) of its `content` plus a fixed cost of
   * 64 characters. Thus the default limit keeps a maximum of 16384
   * entries. All entries that the worker sends for the run count. The
   * system entries of the runner do not count. When an entry makes the
   * total more than the limit, the runner drops it and all later output of
   * the run. It adds one system entry in their place. The run continues.
   * Defaults to 1048576. It must be a safe integer greater than 0. Else the
   * constructor throws a `RangeError`.
   */
  maxOutputChars?: number;
}

/** What `onRun` reports about the run that just started. */
export interface RunInfo {
  tag: string;
  startTime: number;
  timeoutMs: number;
}

/**
 * A settled run, whether the worker reported that its heap is spent or its
 * engine is broken, and whether the run called `invokeHost()` of a
 * capability.
 */
interface RunOutcome {
  result: ExecutionResult;
  exhausted: boolean;
  broken: boolean;
  calledHost: boolean;
}

interface ActiveJsRun {
  runId: number;
  tag: string;
  output: OutputEntry[];
  startTime: number;
  resolve: (outcome: RunOutcome) => void;
  backstopHandle: ReturnType<typeof setTimeout>;
  /** The capabilities that were enabled when the run started. */
  enabledCaps: SandboxCapability[];
  /** Set when a guest call of this run reached `invokeHost()`. */
  calledHost: boolean;
  /** Aborts when the run ends. Each `invokeHost()` of the run gets its signal. */
  hostCalls: AbortController;
  /** The cost of the worker output that the runner kept for this run, in characters. */
  outputChars: number;
  /** Set when the run reached its output limit. Then the runner drops all output from the worker. */
  outputFull: boolean;
}

/**
 * JS code runner that uses a sandboxed JS engine in a web worker.
 * Execution is off the main thread. Thus abort() and the timeout backstop
 * can always stop a run, hot synchronous loops included. They terminate
 * the worker and respawn it.
 * A supersede replaces the worker the same way. The worker is also
 * replaced between runs on heap exhaustion (with one retry) and when its
 * engine fails to free a runtime (with no retry). As an
 * opt-in, it is also replaced every `recycleAfterRuns` runs.
 */
export class JsRunner implements CodeRunner {
  readonly label = 'JavaScript';
  readonly #ready = createValue(false);
  readonly #isRunning = createValue(false);
  readonly #initError = createValue<string | null>(null);
  readonly ready = this.#ready.asReadonly();
  /**
   * `true` from `execute()` until its run settles. In `'supersede'` mode it
   * stays `true` while the superseding run waits for the replacement
   * worker to boot. At that time, `activeTag` is already `null`, because
   * the tag is set only when the run is posted to the worker.
   */
  readonly isRunning = this.#isRunning.asReadonly();
  readonly initError = this.#initError.asReadonly();

  readonly #activeTag = createValue<string | null>(null);
  readonly #queued = createValue(0);
  /**
   * The tag of the run that the worker executes, else `null`. It is also
   * `null` while a superseding run waits for a respawned worker (see
   * `isRunning`).
   */
  readonly activeTag = this.#activeTag.asReadonly();
  /** Runs waiting for the one in flight to end (`'queue'` mode only). */
  readonly queued = this.#queued.asReadonly();

  readonly #output = createEmitter<OutputEntry>();
  readonly #run = createEmitter<RunInfo | null>();
  readonly #recycle = createEmitter<string>();

  #timeoutMs: number;

  /**
   * Per-run time limit (ms). The runner reads it at the start of every
   * run. The setter throws a `RangeError` for a value that is not a
   * finite number greater than 0 and at most 2147481647.
   */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  set timeoutMs(value: number) {
    this.#timeoutMs = checkTimeLimit('timeoutMs', value, BACKSTOP_GRACE_MS);
  }

  readonly #registry: CapabilityStore;
  readonly #workerFactory: () => Worker;
  readonly #concurrency: 'supersede' | 'queue';
  readonly #recycleAfterRuns: number;
  readonly #recoverExhaustion: boolean;
  readonly #bootTimeoutMs: number;
  readonly #maxOutputChars: number;

  #worker: Worker | null = null;
  #runSeq = 0;
  #runsSinceSpawn = 0;
  #activeRun: ActiveJsRun | null = null;
  #spawnPromise: Promise<void> | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  /** Every `'supersede'`-mode execute() increments this. A stale ticket never starts. */
  #requestSeq = 0;
  /** Tickets up to this one were aborted before they started (abort()/dispose()). */
  #abortedSeq = 0;
  /** Wakes the `'supersede'`-mode runs that wait for a respawn, so they settle without it. */
  readonly #wakeWaiting = new Set<() => void>();
  /** Fails each boot in progress (used by `dispose()`). */
  readonly #cancelBoots = new Set<() => void>();
  #disposed = false;

  constructor(registry: CapabilityStore, options: JsRunnerOptions) {
    this.#registry = registry;
    this.#workerFactory = options.workerFactory;
    this.#timeoutMs = checkTimeLimit('timeoutMs', options.timeoutMs ?? 5000, BACKSTOP_GRACE_MS);
    this.#concurrency = options.concurrency ?? 'supersede';
    this.#recycleAfterRuns = options.recycleAfterRuns ?? 0;
    this.#recoverExhaustion = options.recoverExhaustion ?? true;
    this.#bootTimeoutMs = checkTimeLimit(
      'bootTimeoutMs',
      options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
      0,
    );
    this.#maxOutputChars = checkCount(
      'maxOutputChars',
      options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    );
  }

  onOutput(fn: (entry: OutputEntry) => void): () => void {
    return this.#output.subscribe(fn);
  }

  /**
   * Called with the run that just started, and with `null` when it ends
   * (finished, timed out or aborted). An exhaustion retry is a second run.
   */
  onRun(fn: (run: RunInfo | null) => void): () => void {
    return this.#run.subscribe(fn);
  }

  /**
   * Called when the worker is replaced outside abort/timeout: with
   * `'periodic'` for `recycleAfterRuns`, with `'broken'` after the engine
   * failed to free a runtime, or with the run's error message after the
   * worker reported a spent heap.
   */
  onRecycle(fn: (reason: string) => void): () => void {
    return this.#recycle.subscribe(fn);
  }

  /**
   * Starts the worker and waits for its engine to load. Rejects with the
   * load error, which also stays in `initError`. The load error is one of
   * these: the factory throws, the worker's `error` event, its init error,
   * or no `ready` within `bootTimeoutMs`. Call again to retry. After the
   * runner is disposed, it resolves and does not boot. This also applies
   * when `dispose()` stops a boot before it completes.
   */
  async initialize(): Promise<void> {
    if (this.#disposed) return;
    if (this.#worker && this.#ready.get()) return;
    if (this.#spawnPromise) return this.#spawnPromise;
    const spawn = this.#spawnAndLoad();
    this.#spawnPromise = spawn;
    try {
      await spawn;
      this.#initError.set(null);
      this.#ready.set(true);
    } catch (e) {
      if (this.#disposed) return;
      this.#initError.set(e instanceof Error ? e.message : String(e));
      this.#ready.set(false);
      throw e;
    } finally {
      // A supersede can start a newer worker in this time. Keep that one.
      if (this.#spawnPromise === spawn) this.#spawnPromise = null;
    }
  }

  /**
   * Runs `code` and settles with its result. It never rejects. A
   * `timeoutMs` option that is not a finite number greater than 0 and at
   * most 2147481647 settles the run as a failure at once. That run does
   * not start, and the run in flight continues.
   */
  execute(code: string, options: ExecuteOptions = {}): Promise<ExecutionResult> {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const tag = options.tag ?? '';
    const problem = timeLimitProblem('timeoutMs', timeoutMs, BACKSTOP_GRACE_MS);
    if (problem !== null) {
      return Promise.resolve({
        success: false,
        output: [{ type: 'system', content: problem, timestamp: Date.now() }],
        error: problem,
        timedOut: false,
        durationMs: 0,
      });
    }
    if (this.#concurrency === 'supersede') {
      const ticket = ++this.#requestSeq;
      // Settle the runs that this one takes over now, so that their promises
      // cannot hang behind the respawn. These are the run in flight and the
      // runs that still wait for a worker. Those runs wake, see a stale
      // ticket and never start. A queued run never overlaps.
      if (this.#activeRun) this.#supersede();
      for (const wake of [...this.#wakeWaiting]) wake();
      return this.#executeNow(code, timeoutMs, tag, ticket);
    }
    this.#queued.update((n) => n + 1);
    const run = this.#chain.then(() => {
      this.#queued.update((n) => n - 1);
      return this.#executeNow(code, timeoutMs, tag, null);
    });
    // Keep the chain alive past a failed link so later runs still start.
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #executeNow(
    code: string,
    timeoutMs: number,
    tag: string,
    ticket: number | null,
    retried = false,
  ): Promise<ExecutionResult> {
    if (
      this.#recycleAfterRuns > 0 &&
      this.#runsSinceSpawn >= this.#recycleAfterRuns &&
      this.#worker &&
      !this.#activeRun &&
      !this.#spawnPromise &&
      !this.#disposed
    ) {
      this.#replaceWorker('periodic');
    }
    // A respawn after abort/timeout/supersede can still be in flight. Wait
    // for it, so that back-to-back execute() calls do not race the boot of
    // the new worker.
    // A supersede-mode run also wakes early when abort() cancels it.
    if (this.#spawnPromise) {
      let wake = () => {};
      const woken = new Promise<void>((r) => (wake = r));
      if (ticket !== null) this.#wakeWaiting.add(wake);
      try {
        await Promise.race([this.#spawnPromise, woken]);
      } catch {
        // The not-initialized result below shows the failure.
      } finally {
        this.#wakeWaiting.delete(wake);
      }
    }
    // Stop was pressed or the runner was disposed before this run started.
    // The run settles as aborted and is never posted.
    if (this.#disposed || (ticket !== null && ticket <= this.#abortedSeq)) {
      if (!this.#activeRun) this.#isRunning.set(false);
      return {
        success: false,
        output: [{ type: 'system', content: ABORT_MSG, timestamp: Date.now() }],
        error: ABORT_MSG,
        timedOut: false,
        durationMs: 0,
      };
    }
    // A newer execute() arrived while this one waited: it wins, and this
    // run is never posted.
    if (ticket !== null && ticket !== this.#requestSeq) {
      return {
        success: false,
        output: [{ type: 'system', content: SUPERSEDED_MSG, timestamp: Date.now() }],
        error: SUPERSEDED_MSG,
        timedOut: false,
        durationMs: 0,
      };
    }
    if (!this.#worker || !this.#ready.get()) {
      // A superseded run left isRunning set for this one. Nothing starts now.
      if (!this.#activeRun) this.#isRunning.set(false);
      return {
        success: false,
        output: [{ type: 'system', content: NOT_READY_MSG, timestamp: Date.now() }],
        error: NOT_READY_MSG,
        timedOut: false,
        durationMs: 0,
      };
    }

    this.#isRunning.set(true);
    const runId = ++this.#runSeq;
    const startTime = Date.now();

    const enabled = this.#registry.enabledCapabilities.get();
    const capabilities: JsCapabilitySnapshot[] = this.#registry.getAll().map((cap) => ({
      name: cap.name,
      enabled: enabled.includes(cap),
      stub: cap.stubInfo,
      hostBacked: typeof cap.invokeHost === 'function',
      ...(cap.setupScript !== undefined ? { setupScript: cap.setupScript } : {}),
    }));

    const enabledNames = enabled.map((c) => c.name);
    const sysMsg =
      enabledNames.length > 0
        ? `[${enabledNames.join(', ')} enabled]`
        : '[no capabilities enabled]';
    const sysEntry: OutputEntry = { type: 'system', content: sysMsg, timestamp: Date.now() };
    const output: OutputEntry[] = [sysEntry];
    const worker = this.#worker;
    this.#runsSinceSpawn++;

    const { result, exhausted, broken, calledHost } = await new Promise<RunOutcome>((resolve) => {
      const backstopHandle = setTimeout(
        () => this.#kill(runId, 'timeout'),
        timeoutMs + BACKSTOP_GRACE_MS,
      );
      this.#activeRun = {
        runId,
        tag,
        output,
        startTime,
        resolve,
        backstopHandle,
        enabledCaps: enabled,
        calledHost: false,
        hostCalls: new AbortController(),
        outputChars: 0,
        outputFull: false,
      };
      const msg: JsMainToWorkerMsg = {
        type: 'run',
        runId,
        code,
        timeoutMs,
        maxOutputChars: this.#maxOutputChars,
        capabilities,
      };
      worker.postMessage(msg);
      this.#activeTag.set(tag);
      this.#run.emit({ tag, startTime, timeoutMs });
      this.#output.emit(sysEntry);
    });

    // The engine of the worker failed to free a runtime. Its later runs can
    // lose output, host calls and stubs, thus always replace it. Do not
    // retry the run: its guest code already ran.
    if (broken && this.#worker === worker && !this.#disposed) {
      this.#replaceWorker(BROKEN_REASON);
      return result;
    }

    // Recover only when the worker of this run reported a spent heap.
    // Otherwise, a kill already replaced the worker and reported its own
    // failure. Retry only a run without host calls: a retry does the side
    // effects of those calls again.
    if (
      this.#recoverExhaustion &&
      exhausted &&
      !result.success &&
      !result.timedOut &&
      this.#worker === worker &&
      !this.#disposed
    ) {
      this.#replaceWorker(result.error ?? 'exhausted');
      if (!retried && !calledHost) return this.#executeNow(code, timeoutMs, tag, ticket, true);
    }
    return result;
  }

  /**
   * Terminates the worker immediately and respawns it. Thus abort can
   * stop all runs, including hot synchronous loops, runaway timer drains
   * and runs suspended on a pending fetch. A run can still wait for the
   * worker that replaces a superseded run. That run is cancelled before
   * it is posted. No-op when idle.
   */
  async abort(): Promise<void> {
    this.#cancelWaiting();
    if (this.#activeRun) this.#kill(this.#activeRun.runId, 'abort');
  }

  /**
   * Terminates the worker and settles any in-flight run as aborted. The
   * runner is unusable after this. Its subscribers are dropped.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelWaiting();
    if (this.#activeRun) this.#kill(this.#activeRun.runId, 'abort');
    // Fail every pending boot now. Do not leave its timer armed.
    for (const cancel of [...this.#cancelBoots]) cancel();
    this.#worker?.terminate();
    this.#worker = null;
    this.#ready.clear();
    this.#isRunning.clear();
    this.#initError.clear();
    this.#activeTag.clear();
    this.#queued.clear();
    this.#output.clear();
    this.#run.clear();
    this.#recycle.clear();
  }

  // ---------- private helpers ----------

  async #spawnAndLoad(): Promise<void> {
    this.#runsSinceSpawn = 0;
    // If the factory throws, this (async) call rejects, as for all load
    // failures.
    const worker = this.#workerFactory();
    this.#worker = worker;
    // The worker is untrusted. Each message gets a shape check first, and
    // all that is malformed or unknown is dropped. All messages from a
    // worker that was replaced are also dropped.
    worker.addEventListener('message', (e: MessageEvent<unknown>) => {
      if (this.#worker === worker) this.#handleWorkerMessage(worker, e.data);
    });
    worker.addEventListener('error', (e: ErrorEvent) => {
      if (this.#worker === worker) this.#initError.set(workerErrorMessage(e));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        // Without this, a worker that never answers leaves this pending.
        const bootTimer = setTimeout(
          () =>
            settle(new Error(`JS worker did not become ready within ${this.#bootTimeoutMs} ms.`)),
          this.#bootTimeoutMs,
        );
        const settle = (err: Error | null) => {
          clearTimeout(bootTimer);
          this.#cancelBoots.delete(cancel);
          worker.removeEventListener('message', onMsg);
          worker.removeEventListener('error', onError);
          if (err) reject(err);
          else resolve();
        };
        const onMsg = (e: MessageEvent<unknown>) => {
          const checked = checkWorkerMessage(e.data);
          if (!checked.ok) return;
          if (checked.msg.type === 'ready') settle(null);
          else if (checked.msg.type === 'init-error') settle(new Error(checked.msg.message));
        };
        // A worker that the browser refuses to load fires only `error`.
        const onError = (e: ErrorEvent) => settle(new Error(workerErrorMessage(e)));
        const cancel = () => settle(new Error('JS runner disposed.'));
        this.#cancelBoots.add(cancel);
        worker.addEventListener('message', onMsg);
        worker.addEventListener('error', onError);
      });
    } catch (e) {
      worker.terminate();
      if (this.#worker === worker) this.#worker = null;
      throw e;
    }
  }

  #handleWorkerMessage(worker: Worker, data: unknown): void {
    const checked = checkWorkerMessage(data);
    if (!checked.ok) {
      // Answer a malformed call so the guest's await does not hang.
      if (checked.capCall) this.#replyCapError(worker, checked.capCall, checked.reason);
      return;
    }
    const msg = checked.msg;
    switch (msg.type) {
      case 'ready':
      case 'init-error':
        return;
      case 'output':
        if (this.#activeRun?.runId === msg.runId) this.#addOutput(this.#activeRun, msg.entry);
        return;
      case 'cap-call':
        void this.#dispatchCapCall(worker, msg);
        return;
      case 'done':
        this.#completeRun(msg);
        return;
    }
  }

  /**
   * Keeps an entry from the worker, in the output limit of the run. Each
   * entry costs its characters plus `OUTPUT_ENTRY_COST`. The first entry
   * that makes the total more than the limit, and all entries after it,
   * are dropped. One system entry tells about the drop.
   */
  #addOutput(run: ActiveJsRun, entry: OutputEntry): void {
    if (run.outputFull) return;
    const cost = entry.content.length + OUTPUT_ENTRY_COST;
    if (cost > this.#maxOutputChars - run.outputChars) {
      run.outputFull = true;
      const notice: OutputEntry = {
        type: 'system',
        content: outputLimitMsg(this.#maxOutputChars),
        timestamp: Date.now(),
      };
      run.output.push(notice);
      this.#output.emit(notice);
      return;
    }
    run.outputChars += cost;
    run.output.push(entry);
    this.#output.emit(entry);
  }

  async #dispatchCapCall(
    worker: Worker,
    msg: Extract<JsWorkerToMainMsg, { type: 'cap-call' }>,
  ): Promise<void> {
    // Ignore calls from a run that ended. A reply goes to the wrong run.
    if (this.#activeRun?.runId !== msg.runId) return;
    // Only the host's own enabled set counts, never what the worker claims.
    // The capability must be enabled when the run started and when the call
    // arrives, as the same object. Thus a capability that the host enables
    // or replaces during a run is available only from the next run.
    const started = this.#activeRun.enabledCaps.find((c) => c.name === msg.capability);
    const cap =
      started !== undefined &&
      this.#registry.isEnabled(msg.capability) &&
      this.#registry.getCapability(msg.capability) === started
        ? started
        : undefined;
    let reply: JsMainToWorkerMsg;
    if (!cap || typeof cap.invokeHost !== 'function') {
      reply = {
        type: 'cap-result',
        callId: msg.callId,
        ok: false,
        error: copyPrefix(
          `capability '${msg.capability}' is not enabled or has no host implementation`,
          MAX_ERROR_CHARS,
        ),
      };
    } else if (!declaredMethods(cap.stubInfo).includes(msg.method)) {
      // Only the guest functions the host declared may be called, so a
      // capability never sees a method name it did not publish.
      reply = {
        type: 'cap-result',
        callId: msg.callId,
        ok: false,
        error: copyPrefix(
          `capability '${msg.capability}' has no method '${msg.method}'`,
          MAX_ERROR_CHARS,
        ),
      };
    } else {
      this.#activeRun.calledHost = true;
      try {
        const value = await cap.invokeHost(msg.method, msg.args, {
          signal: this.#activeRun.hostCalls.signal,
        });
        reply = { type: 'cap-result', callId: msg.callId, ok: true, value };
      } catch (e) {
        reply = {
          type: 'cap-result',
          callId: msg.callId,
          ok: false,
          error: hostErrorMessage(e),
        };
      }
    }
    // The run can be aborted or superseded while the host call is in
    // flight. Call ids restart in every worker, so the reply goes only to
    // the worker that asked, and only while it is still current.
    if (this.#activeRun?.runId === msg.runId && this.#worker === worker) {
      try {
        worker.postMessage(reply);
      } catch (e) {
        // An un-cloneable result (DataCloneError): answer with an error so
        // the guest's await does not hang until the timeout.
        this.#replyCapError(worker, msg, hostErrorMessage(e));
      }
    }
  }

  /** Error `cap-result` for a malformed call from the active run. */
  #replyCapError(worker: Worker, call: { callId: number; runId: number }, error: string): void {
    if (this.#activeRun?.runId !== call.runId || this.#worker !== worker) return;
    const reply: JsMainToWorkerMsg = { type: 'cap-result', callId: call.callId, ok: false, error };
    try {
      worker.postMessage(reply);
    } catch {
      // A plain error reply cannot fail to clone. But the post itself can
      // still throw, for example for a worker that is closing. Do not let
      // that error escape as an unhandled rejection. The timeout backstop
      // of the run still ends a guest that waits for this reply.
    }
  }

  #completeRun(msg: Extract<JsWorkerToMainMsg, { type: 'done' }>): void {
    if (!this.#activeRun || this.#activeRun.runId !== msg.runId) return;
    const { output, startTime, resolve, backstopHandle, enabledCaps, calledHost, hostCalls } =
      this.#activeRun;
    clearTimeout(backstopHandle);
    this.#activeRun = null;
    this.#isRunning.set(false);
    this.#activeTag.set(null);
    this.#run.emit(null);

    this.#cleanupCaps(enabledCaps, hostCalls);

    resolve({
      result: {
        // A run on a broken engine is never a success.
        success: msg.success && msg.broken !== true,
        output,
        // A copy, not a slice. A slice can keep the full string alive.
        ...(msg.error !== undefined ? { error: copyPrefix(msg.error, MAX_ERROR_CHARS) } : {}),
        timedOut: msg.timedOut,
        durationMs: Date.now() - startTime,
      },
      exhausted: msg.exhausted === true,
      broken: msg.broken === true,
      calledHost,
    });
  }

  #kill(runId: number, reason: 'abort' | 'timeout'): void {
    if (!this.#activeRun || this.#activeRun.runId !== runId) return;
    const { output, startTime, resolve, backstopHandle, enabledCaps, hostCalls } = this.#activeRun;
    clearTimeout(backstopHandle);
    this.#activeRun = null;
    this.#isRunning.set(false);

    const msg = reason === 'abort' ? ABORT_MSG : TIMEOUT_MSG;
    const entry: OutputEntry = { type: 'system', content: msg, timestamp: Date.now() };
    output.push(entry);
    this.#output.emit(entry);
    this.#activeTag.set(null);
    this.#run.emit(null);

    this.#worker?.terminate();
    this.#worker = null;
    this.#ready.set(false);
    if (!this.#disposed) this.#respawn();

    this.#cleanupCaps(enabledCaps, hostCalls);

    resolve({
      result: {
        success: false,
        output,
        error: msg,
        timedOut: reason === 'timeout',
        durationMs: Date.now() - startTime,
      },
      exhausted: false,
      broken: false,
      calledHost: false,
    });
  }

  /**
   * Settles the run in flight as superseded and replaces its worker. The
   * old worker cannot be used again. It can be stuck in a hot loop or
   * suspended on a host call. The engine allows one suspension at a time,
   * so all host calls of the next run fail. isRunning stays true, because
   * the superseding run starts when the new worker is ready.
   */
  #supersede(): void {
    if (!this.#activeRun) return;
    const { output, startTime, resolve, backstopHandle, enabledCaps, hostCalls } = this.#activeRun;
    clearTimeout(backstopHandle);
    this.#activeRun = null;

    const entry: OutputEntry = { type: 'system', content: SUPERSEDED_MSG, timestamp: Date.now() };
    output.push(entry);
    this.#output.emit(entry);
    this.#activeTag.set(null);
    this.#run.emit(null);

    this.#worker?.terminate();
    this.#worker = null;
    this.#ready.set(false);
    if (!this.#disposed) this.#respawn();

    this.#cleanupCaps(enabledCaps, hostCalls);

    resolve({
      result: {
        success: false,
        output,
        error: SUPERSEDED_MSG,
        timedOut: false,
        durationMs: Date.now() - startTime,
      },
      exhausted: false,
      broken: false,
      calledHost: false,
    });
  }

  /** Swaps in a fresh worker between runs and reports why. */
  #replaceWorker(reason: string): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#ready.set(false);
    this.#respawn();
    this.#recycle.emit(reason);
  }

  #respawn(): void {
    const spawn = this.#spawnAndLoad();
    this.#spawnPromise = spawn;
    // A supersede during this boot starts a newer worker. Only the newest
    // worker can mark the runner ready, report its error or clear the slot.
    spawn
      .then(() => {
        if (this.#spawnPromise !== spawn) return;
        this.#initError.set(null);
        this.#ready.set(true);
      })
      .catch((err) => {
        if (this.#disposed || this.#spawnPromise !== spawn) return;
        this.#initError.set(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (this.#spawnPromise === spawn) this.#spawnPromise = null;
      });
  }

  /** Cancels every `'supersede'`-mode run that has not been posted yet. */
  #cancelWaiting(): void {
    this.#abortedSeq = this.#requestSeq;
    for (const wake of [...this.#wakeWaiting]) wake();
    if (!this.#activeRun) this.#isRunning.set(false);
  }

  /** Aborts the host calls of the run that ends. Then calls `cleanup()` of each capability. */
  #cleanupCaps(caps: { cleanup?(): void | Promise<void> }[], hostCalls: AbortController): void {
    hostCalls.abort();
    for (const cap of [...caps].reverse()) {
      try {
        // A rejected cleanup must not become an unhandled rejection.
        void Promise.resolve(cap.cleanup?.()).catch(() => {});
      } catch {
        // Best effort.
      }
    }
  }
}
