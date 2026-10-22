import type { ReadableValue } from './readable-value.js';
import type { ExecutionResult, OutputEntry } from './sandbox-types.js';

/** Per-run overrides accepted by every runner's `execute()`. */
export interface ExecuteOptions {
  /** Time limit for this run (ms). Defaults to the runner's `timeoutMs`. */
  timeoutMs?: number;
  /**
   * Names the caller; readable as `activeTag` while the run is in flight
   * (e.g. so a host capability can tell who started it). Defaults to `''`.
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
  execute(code: string, options?: ExecuteOptions): Promise<ExecutionResult>;
  abort(): Promise<void>;
  /**
   * Streams a started run's output: `fn` is called for each entry as it is
   * appended to the run's `output`, so it sees the same entries in the
   * same order the result will carry. Returns an unsubscribe function.
   */
  onOutput(fn: (entry: OutputEntry) => void): () => void;
}
