import type { OutputEntry } from '../shared/sandbox-types.js';
import type { CapabilityStubInfo } from '../capabilities/capability.js';

/**
 * The message of a run that exceeded its time limit. The worker and the
 * runner both use it, so that all timeouts look the same.
 */
export const TIMEOUT_MSG = 'Execution timed out: script exceeded the time limit.';

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
    };
