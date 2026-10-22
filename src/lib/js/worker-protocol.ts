import type { OutputEntry } from '../shared/sandbox-types.js';
import type { CapabilityStubInfo } from '../capabilities/capability.js';

/**
 * Per-run snapshot of one registered capability, sent to the JS worker.
 * The worker installs RPC bridge functions for enabled host-backed
 * capabilities, provides `timer` natively in-worker, and installs
 * throwing stubs for everything disabled.
 */
export interface JsCapabilitySnapshot {
  name: string;
  enabled: boolean;
  stub: CapabilityStubInfo;
  /** True when the main-thread capability implements invokeHost(). */
  hostBacked: boolean;
  /** Guest JS evaluated after bridge injection (e.g. fetch's response wrapper). */
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
  | { type: 'done'; runId: number; success: boolean; error?: string; timedOut: boolean };
