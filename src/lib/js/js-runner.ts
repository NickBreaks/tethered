import { createValue } from '../shared/readable-value.js';
import { createEmitter } from '../shared/emitter.js';
import type { CapabilityStore } from '../capabilities/capability-store.js';
import type { CapabilityStubInfo } from '../capabilities/capability.js';
import type { OutputEntry, ExecutionResult } from '../shared/sandbox-types.js';
import type { CodeRunner, ExecuteOptions } from '../shared/code-runner.js';
import type {
  JsCapabilitySnapshot,
  JsMainToWorkerMsg,
  JsWorkerToMainMsg,
} from './worker-protocol.js';
import { checkWorkerMessage } from './check-worker-message.js';

export type { OutputEntry, ExecutionResult } from '../shared/sandbox-types.js';

const ABORT_MSG = 'Execution aborted.';
const TIMEOUT_MSG = 'Execution timed out: script exceeded the time limit.';
const SUPERSEDED_MSG = 'Execution superseded by a newer run.';

/**
 * Grace period added to timeoutMs for the main-thread backstop timer.
 * The worker normally ends timed-out runs itself via its interrupt
 * handler; the backstop only fires when the worker can't (e.g. it is
 * asyncify-suspended awaiting a capability RPC that never resolves),
 * and then the worker is terminated and respawned.
 */
const BACKSTOP_GRACE_MS = 2000;

const DEFAULT_BOOT_TIMEOUT_MS = 30_000;

/**
 * Errors that mean the worker's heap is spent, not that the code was
 * wrong: a spent heap poisons every later run (even capability setup
 * scripts fail), so the worker is replaced and the run retried once.
 */
const EXHAUSTED = /out of memory|setup failed|InternalError/i;

/**
 * The guest functions the worker installs for a capability (mirrors the
 * capability bridge): a function capability's globals, else its own
 * name; an object capability's methods.
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
   * Spawns the JS worker (required). `defaultJsWorkerFactory` from
   * `tethered/workers` spawns the bundled one (without a global
   * `Worker` it needs `createJsWorkerFactory({ allowInProcess: true })`); Vite-style apps
   * can build their own on the package's worker-script export (see the
   * README).
   */
  workerFactory: () => Worker;
  timeoutMs?: number;
  /**
   * What `execute()` does while a run is in flight. `'supersede'`
   * (default): the older run settles immediately as a failure
   * ("superseded"), its worker is terminated, and the new run starts on a
   * freshly spawned worker once that is ready. This also stops an older
   * run stuck in a hot loop or suspended on a host call that never
   * returns. A run superseded before it started settles the same way
   * without being posted. `'queue'`: the new run starts after every
   * earlier run has settled (finished, timed out or aborted).
   */
  concurrency?: 'supersede' | 'queue';
  /**
   * Replace the worker between runs once it has served this many, as
   * insurance against slow leaks in the WASM heap. Off by default.
   */
  recycleAfterRuns?: number;
  /**
   * When a run fails with a heap-exhaustion error, respawn the worker and
   * retry the run once on the fresh one. Defaults to `true`.
   */
  recoverExhaustion?: boolean;
  /**
   * How long a freshly spawned worker may take to report ready (ms). Past
   * it the worker is terminated and the boot fails like a load error:
   * `initialize()` rejects and `initError` is set. Defaults to 30000.
   */
  bootTimeoutMs?: number;
}

/** What `onRun` reports about the run that just started. */
export interface RunInfo {
  tag: string;
  startTime: number;
  timeoutMs: number;
}

interface ActiveJsRun {
  runId: number;
  tag: string;
  output: OutputEntry[];
  startTime: number;
  resolve: (r: ExecutionResult) => void;
  backstopHandle: ReturnType<typeof setTimeout> | null;
  enabledCaps: { cleanup?(): void | Promise<void> }[];
}

/**
 * JS code runner backed by a sandboxed JS engine in a web worker. Because execution
 * is off the main thread, abort() and the timeout backstop can always
 * stop a run — including hot synchronous loops — by terminating the
 * worker and respawning it.
 * Superseding a run replaces the worker the same way. The worker is also
 * replaced between runs on heap exhaustion (with one retry) and, opt-in,
 * every `recycleAfterRuns` runs.
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
   * worker to boot, even though `activeTag` is already `null` then: the
   * tag is set only once the run is posted to the worker.
   */
  readonly isRunning = this.#isRunning.asReadonly();
  readonly initError = this.#initError.asReadonly();

  readonly #activeTag = createValue<string | null>(null);
  readonly #queued = createValue(0);
  /**
   * The tag of the run the worker is executing, else `null` (including
   * while a superseding run waits for a respawned worker; see `isRunning`).
   */
  readonly activeTag = this.#activeTag.asReadonly();
  /** Runs waiting for the one in flight to end (`'queue'` mode only). */
  readonly queued = this.#queued.asReadonly();

  readonly #output = createEmitter<OutputEntry>();
  readonly #run = createEmitter<RunInfo | null>();
  readonly #recycle = createEmitter<string>();

  /** Per-run time limit; read at the start of every run. */
  timeoutMs: number;

  readonly #registry: CapabilityStore;
  readonly #workerFactory: () => Worker;
  readonly #concurrency: 'supersede' | 'queue';
  readonly #recycleAfterRuns: number;
  readonly #recoverExhaustion: boolean;
  readonly #bootTimeoutMs: number;

  #worker: Worker | null = null;
  #runSeq = 0;
  #runsSinceSpawn = 0;
  #activeRun: ActiveJsRun | null = null;
  #spawnPromise: Promise<void> | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  /** Bumped by every `'supersede'`-mode execute(); a stale ticket never starts. */
  #requestSeq = 0;
  /** Tickets up to this one were aborted before they started (abort()/dispose()). */
  #abortedSeq = 0;
  /** Wakes the `'supersede'`-mode runs waiting on a respawn, so they settle without it. */
  readonly #wakeWaiting = new Set<() => void>();
  /** Fails each boot in progress (used by `dispose()`). */
  readonly #cancelBoots = new Set<() => void>();
  #disposed = false;

  constructor(registry: CapabilityStore, options: JsRunnerOptions) {
    this.#registry = registry;
    this.#workerFactory = options.workerFactory;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.#concurrency = options.concurrency ?? 'supersede';
    this.#recycleAfterRuns = options.recycleAfterRuns ?? 0;
    this.#recoverExhaustion = options.recoverExhaustion ?? true;
    this.#bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
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
   * `'periodic'` for `recycleAfterRuns`, or with the run's error message
   * after a heap-exhaustion failure.
   */
  onRecycle(fn: (reason: string) => void): () => void {
    return this.#recycle.subscribe(fn);
  }

  /**
   * Spawns the worker and waits for its engine to load. Rejects with the
   * load error (the factory throwing, the worker's `error` event, its init
   * error, or no `ready` within `bootTimeoutMs`), which is also left in
   * `initError`; calling again retries. Resolves without booting once the
   * runner is disposed, including when `dispose()` cuts a boot short.
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
      // A supersede may have started a newer spawn meanwhile; keep that one.
      if (this.#spawnPromise === spawn) this.#spawnPromise = null;
    }
  }

  execute(code: string, options: ExecuteOptions = {}): Promise<ExecutionResult> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const tag = options.tag ?? '';
    if (this.#concurrency === 'supersede') {
      const ticket = ++this.#requestSeq;
      // Settle the run this one takes over now, so its promise can't hang
      // behind the respawn: the one in flight, or ones still waiting for a
      // worker (they wake, see a stale ticket and never start). A queued
      // run never overlaps.
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
    // A respawn after abort/timeout/supersede may still be in flight — wait for it
    // so back-to-back execute() calls don't race the new worker's boot.
    // A supersede-mode run also wakes early when abort() cancels it.
    if (this.#spawnPromise) {
      let wake = () => {};
      const woken = new Promise<void>((r) => (wake = r));
      if (ticket !== null) this.#wakeWaiting.add(wake);
      try {
        await Promise.race([this.#spawnPromise, woken]);
      } catch {
        // Failure surfaces via the not-initialized result below.
      } finally {
        this.#wakeWaiting.delete(wake);
      }
    }
    // Stop was pressed (or the runner disposed) before this run started:
    // it settles as aborted and is never posted.
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
      // A superseded run left isRunning set for this one; nothing starts now.
      if (!this.#activeRun) this.#isRunning.set(false);
      return {
        success: false,
        output: [{ type: 'system', content: 'WASM module not initialized', timestamp: Date.now() }],
        error: 'WASM module not initialized',
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
      enabledNames.length > 0 ? `[${enabledNames.join(', ')} enabled]` : '[no capabilities enabled]';
    const sysEntry: OutputEntry = { type: 'system', content: sysMsg, timestamp: Date.now() };
    const output: OutputEntry[] = [sysEntry];
    const worker = this.#worker;
    this.#runsSinceSpawn++;

    const result = await new Promise<ExecutionResult>((resolve) => {
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
      };
      const msg: JsMainToWorkerMsg = {
        type: 'run',
        runId,
        code,
        timeoutMs,
        capabilities,
      };
      worker.postMessage(msg);
      this.#activeTag.set(tag);
      this.#run.emit({ tag, startTime, timeoutMs });
      this.#output.emit(sysEntry);
    });

    // Only when this run's own worker reported the error: a kill already
    // replaced the worker and reported its own failure.
    if (
      this.#recoverExhaustion &&
      !result.success &&
      !result.timedOut &&
      EXHAUSTED.test(result.error ?? '') &&
      this.#worker === worker &&
      !this.#disposed
    ) {
      this.#replaceWorker(result.error ?? 'exhausted');
      if (!retried) return this.#executeNow(code, timeoutMs, tag, ticket, true);
    }
    return result;
  }

  /**
   * Aborting terminates the worker outright and respawns it, so it
   * stops any run — hot synchronous loops, runaway timer drains, and
   * runs suspended on a pending fetch included. A run still waiting for
   * the worker that replaces a superseded one is cancelled before it is
   * posted. No-op when idle.
   */
  async abort(): Promise<void> {
    this.#cancelWaiting();
    if (this.#activeRun) this.#kill(this.#activeRun.runId, 'abort');
  }

  /**
   * Terminates the worker and settles any in-flight run as aborted. The
   * runner is unusable afterwards; subscribers are dropped.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelWaiting();
    if (this.#activeRun) this.#kill(this.#activeRun.runId, 'abort');
    // Fail every pending boot now rather than leave its timer armed.
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
    // A throwing factory rejects this (async) call like any load failure.
    const worker = this.#workerFactory();
    this.#worker = worker;
    // The worker is untrusted: every message is shape-checked first, and
    // anything malformed or unknown is dropped. So is anything from a
    // worker that has since been replaced.
    worker.addEventListener('message', (e: MessageEvent<unknown>) => {
      if (this.#worker === worker) this.#handleWorkerMessage(worker, e.data);
    });
    worker.addEventListener('error', (e: ErrorEvent) => {
      if (this.#worker === worker) this.#initError.set(workerErrorMessage(e));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        // A worker that never answers would otherwise leave this pending.
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
        // A worker the browser refuses to load only ever fires `error`.
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
      // Answer a malformed call so the guest's await doesn't hang.
      if (checked.capCall) this.#replyCapError(worker, checked.capCall, checked.reason);
      return;
    }
    const msg = checked.msg;
    switch (msg.type) {
      case 'ready':
      case 'init-error':
        return;
      case 'output':
        if (this.#activeRun?.runId === msg.runId) {
          this.#activeRun.output.push(msg.entry);
          this.#output.emit(msg.entry);
        }
        return;
      case 'cap-call':
        void this.#dispatchCapCall(worker, msg);
        return;
      case 'done':
        this.#completeRun(msg);
        return;
    }
  }

  async #dispatchCapCall(
    worker: Worker,
    msg: Extract<JsWorkerToMainMsg, { type: 'cap-call' }>,
  ): Promise<void> {
    // Ignore calls from an ended run; a reply would be misrouted.
    if (this.#activeRun?.runId !== msg.runId) return;
    // Only the host's own enabled set counts, never what the worker claims.
    const cap = this.#registry.isEnabled(msg.capability)
      ? this.#registry.getCapability(msg.capability)
      : undefined;
    let reply: JsMainToWorkerMsg;
    if (!cap || typeof cap.invokeHost !== 'function') {
      reply = {
        type: 'cap-result',
        callId: msg.callId,
        ok: false,
        error: `capability '${msg.capability}' is not enabled or has no host implementation`,
      };
    } else if (!declaredMethods(cap.stubInfo).includes(msg.method)) {
      // Only the guest functions the host declared may be called, so a
      // capability never sees a method name it did not publish.
      reply = {
        type: 'cap-result',
        callId: msg.callId,
        ok: false,
        error: `capability '${msg.capability}' has no method '${msg.method}'`,
      };
    } else {
      try {
        const value = await cap.invokeHost(msg.method, msg.args);
        reply = { type: 'cap-result', callId: msg.callId, ok: true, value };
      } catch (e) {
        reply = {
          type: 'cap-result',
          callId: msg.callId,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
    // The run may have been aborted or superseded while the host call was
    // in flight. Call ids restart in every worker, so the reply goes only
    // to the worker that asked, and only while it is still current.
    if (this.#activeRun?.runId === msg.runId && this.#worker === worker) {
      try {
        worker.postMessage(reply);
      } catch (e) {
        // An un-cloneable result (DataCloneError): answer with an error so
        // the guest's await doesn't hang until the timeout.
        this.#replyCapError(worker, msg, e instanceof Error ? e.message : String(e));
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
      // A plain error reply can't fail to clone, but the post itself can
      // still throw (e.g. a worker that is going away). Don't let that
      // escape as an unhandled rejection: the run's timeout backstop
      // still ends a guest left waiting for this reply.
    }
  }

  #completeRun(msg: Extract<JsWorkerToMainMsg, { type: 'done' }>): void {
    if (!this.#activeRun || this.#activeRun.runId !== msg.runId) return;
    const { output, startTime, resolve, backstopHandle, enabledCaps } = this.#activeRun;
    if (backstopHandle !== null) clearTimeout(backstopHandle);
    this.#activeRun = null;
    this.#isRunning.set(false);
    this.#activeTag.set(null);
    this.#run.emit(null);

    this.#cleanupCaps(enabledCaps);

    resolve({
      success: msg.success,
      output,
      ...(msg.error !== undefined ? { error: msg.error } : {}),
      timedOut: msg.timedOut,
      durationMs: Date.now() - startTime,
    });
  }

  #kill(runId: number, reason: 'abort' | 'timeout'): void {
    if (!this.#activeRun || this.#activeRun.runId !== runId) return;
    const { output, startTime, resolve, backstopHandle, enabledCaps } = this.#activeRun;
    if (backstopHandle !== null) clearTimeout(backstopHandle);
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

    this.#cleanupCaps(enabledCaps);

    resolve({
      success: false,
      output,
      error: msg,
      timedOut: reason === 'timeout',
      durationMs: Date.now() - startTime,
    });
  }

  /**
   * Settles the run in flight as superseded and replaces its worker. The
   * old worker can't be reused: it may be stuck in a hot loop, or
   * suspended on a host call — and the engine allows one suspension at a
   * time, so every host call of the next run would fail. isRunning stays
   * true because the superseding run starts once the new worker is ready.
   */
  #supersede(): void {
    if (!this.#activeRun) return;
    const { output, startTime, resolve, backstopHandle, enabledCaps } = this.#activeRun;
    if (backstopHandle !== null) clearTimeout(backstopHandle);
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

    this.#cleanupCaps(enabledCaps);

    resolve({
      success: false,
      output,
      error: SUPERSEDED_MSG,
      timedOut: false,
      durationMs: Date.now() - startTime,
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
    // A supersede during this boot starts a newer spawn: only the newest
    // one may mark the runner ready, report its error or clear the slot.
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

  #cleanupCaps(caps: { cleanup?(): void | Promise<void> }[]): void {
    for (const cap of [...caps].reverse()) {
      try {
        void cap.cleanup?.();
      } catch {
        // Best effort.
      }
    }
  }
}
