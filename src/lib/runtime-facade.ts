import {
  createValue,
  derived,
  type DerivedValue,
  type ReadableValue,
  type WritableValue,
} from './shared/readable-value.js';
import type { CodeRunner, ExecuteOptions } from './shared/code-runner.js';
import type { ExecutionResult, OutputEntry } from './shared/sandbox-types.js';

/** The runners a facade dispatches to, keyed by mode (for example, `{ js, ts }`). */
export type FacadeRunners = Readonly<Record<string, CodeRunner>>;

/**
 * Language-agnostic front door: owns the active mode and the output log,
 * and delegates to the runner registered under that mode.
 */
export class RuntimeFacade {
  readonly #runners: FacadeRunners;
  /**
   * Modes whose facade-started `initialize()` is in flight or resolved.
   * A failed one is removed again, so the next switch to it retries.
   */
  readonly #initialized = new Set<string>();
  /**
   * Failure messages of the initializations this facade started, by mode.
   * An entry lasts until that runner becomes ready or is retried.
   */
  readonly #initFailures = createValue<Readonly<Record<string, string>>>({});
  readonly #unsubscribes: (() => void)[] = [];

  readonly #mode: WritableValue<string>;
  readonly mode: ReadableValue<string>;

  readonly #output = createValue<OutputEntry[]>([]);
  readonly output = this.#output.asReadonly();

  readonly ready: DerivedValue<boolean>;
  readonly isRunning: DerivedValue<boolean>;
  readonly initError: DerivedValue<string | null>;

  #runIdCounter = 0;

  /** Throws if `initialMode` is not a key of `runners`. */
  constructor(runners: FacadeRunners, initialMode = 'js') {
    this.#runners = { ...runners };
    this.#check(initialMode);
    this.#mode = createValue(initialMode);
    this.mode = this.#mode.asReadonly();

    // Re-expose the active runner's state. Every runner is a source, so a
    // change on a runner or on the mode causes a new evaluation.
    const all = Object.values(this.#runners);
    const active = () => this.#runners[this.#mode.get()];
    const sources = (pick: (r: CodeRunner) => ReadableValue<unknown>) => [
      this.#mode,
      ...all.map(pick),
    ];
    this.ready = derived(sources((r) => r.ready), () => active().ready.get());
    this.isRunning = derived(sources((r) => r.isRunning), () => active().isRunning.get());
    // The runner's own message has priority. The fallback is a bare
    // rejection of an initialize() that the facade started.
    this.initError = derived(
      [...sources((r) => r.initError), this.#initFailures],
      () => active().initError.get() ?? this.#initFailures.get()[this.#mode.get()] ?? null,
    );
    // A runner that recovers on its own (a manual retry, a respawn) must
    // not keep reporting the facade's stale failure.
    for (const [mode, runner] of Object.entries(this.#runners)) {
      this.#unsubscribes.push(
        runner.ready.subscribe((ready) => {
          if (ready) this.#clearFailure(mode);
        }),
      );
    }
  }

  /** The registered modes, in registration order. */
  get modes(): readonly string[] {
    return Object.keys(this.#runners);
  }

  /** The runner registered under `mode`. Throws for an unknown mode. */
  runner(mode: string): CodeRunner {
    this.#check(mode);
    return this.#runners[mode];
  }

  /**
   * Switches the active runner. If you set the current mode, nothing
   * occurs. An unknown mode throws and changes nothing. For other modes,
   * this method:
   *  - aborts the previously active runner.
   *  - replaces the output with a single "Switched to X mode" system entry.
   *  - calls `initialize()` on the new runner if it is not ready. It does
   *    not do this when an earlier facade-started call is still in flight
   *    or resolved.
   *
   * A failure (a rejection or a synchronous throw) shows in `initError`.
   * The next switch to that mode retries. This method never initializes
   * the runner of the initial mode. The code that builds the facade boots
   * that runner.
   */
  setMode(mode: string): void {
    this.#check(mode);
    const prev = this.#mode.get();
    if (prev === mode) return;
    this.#mode.set(mode);
    void this.#runners[prev].abort();
    this.#output.set([
      { type: 'system', content: `Switched to ${this.#label(mode)} mode`, timestamp: Date.now() },
    ]);
    this.#initializeOnce(mode);
  }

  /**
   * Runs `code` on the active runner; `options` are forwarded to it. The
   * runner decides what occurs when it is not ready. `JsRunner` waits for
   * a worker that boots, and gives a failed result when no worker boots.
   */
  async execute(code: string, options?: ExecuteOptions): Promise<ExecutionResult> {
    const myRunId = ++this.#runIdCounter;
    const modeAtStart = this.#mode.get();
    const runner = this.#runners[modeAtStart];

    const result = await (options ? runner.execute(code, options) : runner.execute(code));

    // Supersession: if another execute() started after this one, or the
    // mode changed, discard this result. Then stale output does not leak.
    if (myRunId !== this.#runIdCounter || this.#mode.get() !== modeAtStart) {
      return result;
    }
    this.#output.set(result.output);
    return result;
  }

  async run(code: string, options?: ExecuteOptions): Promise<ExecutionResult> {
    return this.execute(code, options);
  }

  async abort(): Promise<void> {
    await this.#runners[this.#mode.get()].abort();
  }

  /** Detaches the derived values and drops every subscriber. */
  dispose(): void {
    for (const unsub of this.#unsubscribes.splice(0)) unsub();
    this.ready.dispose();
    this.isRunning.dispose();
    this.initError.dispose();
    this.#mode.clear();
    this.#output.clear();
    this.#initFailures.clear();
  }

  #check(mode: string): void {
    if (!Object.hasOwn(this.#runners, mode)) {
      throw new Error(
        `Unknown mode "${mode}"; registered modes: ${Object.keys(this.#runners).join(', ')}.`,
      );
    }
  }

  #label(mode: string): string {
    return this.#runners[mode].label ?? mode;
  }

  #initializeOnce(mode: string): void {
    const runner = this.#runners[mode];
    if (runner.ready.get() || this.#initialized.has(mode)) return;
    this.#initialized.add(mode);
    // A retry replaces the previous failure.
    this.#clearFailure(mode);
    const fail = (e: unknown) => {
      this.#initialized.delete(mode);
      const message = e instanceof Error ? e.message : String(e);
      this.#initFailures.update((f) => ({ ...f, [mode]: message }));
    };
    let started: Promise<void>;
    try {
      started = runner.initialize();
    } catch (e) {
      // A synchronous throw is reported like a rejection, so setMode()
      // never throws after it has switched.
      fail(e);
      return;
    }
    started.then(() => this.#clearFailure(mode), fail);
  }

  #clearFailure(mode: string): void {
    if (!Object.hasOwn(this.#initFailures.get(), mode)) return;
    this.#initFailures.update(({ [mode]: _, ...rest }) => rest);
  }
}
