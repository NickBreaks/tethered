import type { ReadableValue } from './readable-value.js';
import type { ExecutionResult, OutputEntry } from './sandbox-types.js';

/** Per-run overrides accepted by every runner's `execute()`. */
export interface ExecuteOptions {
  /** Time limit for this run (ms). Defaults to the runner's `timeoutMs`. */
  timeoutMs?: number;
  /**
   * Names the caller; readable as `activeTag` while the run is in flight
   * (for example, so a host capability can find who started it). Defaults
   * to `''`.
   */
  tag?: string;
}

export interface CodeRunner {
  /**
   * Display name used in the facade's system entries ("Switched to X
   * mode"). Defaults to the runner's mode key.
   */
  readonly label?: string;
  readonly ready: ReadableValue<boolean>;
  readonly isRunning: ReadableValue<boolean>;
  readonly initError: ReadableValue<string | null>;
  /** The `tag` of the run in flight, or `null` between runs. */
  readonly activeTag: ReadableValue<string | null>;
  initialize(): Promise<void>;
  /**
   * Runs `code`. The facade calls this also when `ready` is `false`. If
   * the runner cannot run the code, it resolves with `success: false`.
   */
  execute(code: string, options?: ExecuteOptions): Promise<ExecutionResult>;
  abort(): Promise<void>;
  /**
   * Streams the output of a started run. `fn` is called for each entry
   * when the entry is added to the run's `output`. Thus `fn` gets the same
   * entries, in the same order, as the result. Returns an unsubscribe
   * function.
   */
  onOutput(fn: (entry: OutputEntry) => void): () => void;
}
