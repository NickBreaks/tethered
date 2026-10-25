import type { OutputEntry } from '../shared/sandbox-types.js';
import type { CapabilityStubInfo } from '../capabilities/capability.js';

/**
 * The message of a run that exceeded its time limit. The worker and the
 * runner both use it, so that all timeouts look the same.
 */
export const TIMEOUT_MSG = 'Execution timed out: script exceeded the time limit.';

/**
 * The fixed cost of each output entry, in characters, in addition to the
 * characters of its `content`. Each entry uses host memory, also when its
 * `content` is empty. Thus a guest cannot make an unlimited number of
 * small entries. The worker and the runner both use this cost.
 */
export const OUTPUT_ENTRY_COST = 64;

/**
 * The maximum length of the `error` of a run, in UTF-16 code units. The
 * guest controls this string, and the output limit does not apply to it.
 * The worker cuts the error before it posts `done`. The runner does not
 * trust the worker, thus it also applies this limit.
 */
export const MAX_ERROR_CHARS = 10_000;

/**
 * Per-run snapshot of one registered capability, sent to the JS worker.
 * The worker installs RPC bridge functions for enabled host-backed
 * capabilities. It supplies `timer` natively in the worker. It installs
 * stubs that throw for all disabled capabilities.
 */
export interface JsCapabilitySnapshot {
  name: string;
  enabled: boolean;
  stub: CapabilityStubInfo;
  /** True when the main-thread capability implements invokeHost(). */
  hostBacked: boolean;
  /** Guest JS evaluated after bridge injection (for example, fetch's response wrapper). */
  setupScript?: string;
}

// ---- Main thread → Worker ----
export type JsMainToWorkerMsg =
  | {
      type: 'run';
      runId: number;
      code: string;
      timeoutMs: number;
      /**
       * The output limit of the run, in characters, over all entries. Each
       * entry costs the characters (UTF-16 code units) of its `content`
       * plus `OUTPUT_ENTRY_COST`. When an entry makes the total more than
       * this limit, the runner drops it and all later entries of the
       * run. The runner does not trust the worker, thus it applies this
       * rule itself. The worker uses the same rule to stop the posts of
       * output that the runner drops.
       */
      maxOutputChars: number;
      capabilities: JsCapabilitySnapshot[];
    }
  | { type: 'cap-result'; callId: number; ok: boolean; value?: unknown; error?: string };

// ---- Worker → Main thread ----
export type JsWorkerToMainMsg =
  | { type: 'ready' }
  | { type: 'init-error'; message: string }
  | { type: 'output'; runId: number; entry: OutputEntry }
  | {
      type: 'cap-call';
      callId: number;
      runId: number;
      capability: string;
      method: string;
      args: unknown[];
    }
  | {
      type: 'done';
      runId: number;
      success: boolean;
      error?: string;
      timedOut: boolean;
      /**
       * True when the worker cannot start a fresh engine (its heap is
       * spent). Only signals that the guest cannot forge set it. The text
       * of `error` never sets it. The runner then replaces the worker and
       * retries the run once.
       */
      exhausted?: boolean;
      /**
       * True when the engine failed to free a context or a runtime. Then
       * the WASM module of the worker is broken, and the worker refuses
       * all later runs. The runner then replaces the worker. It does not
       * retry the run, because the guest code of the run already ran.
       */
      broken?: boolean;
    };
