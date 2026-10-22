import type { OutputEntry } from '../shared/sandbox-types.js';
import type { JsWorkerToMainMsg } from './worker-protocol.js';

/**
 * Host-side shape check for worker→host messages. The worker runs guest
 * code, so everything it posts is untrusted: a message is accepted only
 * when its `type` is known and every required field has the right type.
 *
 * Accepted messages are rebuilt from their known fields, so extra
 * properties never reach the runner or its listeners. Never throws.
 *
 * Capability checks that need the host's state (is it registered, is it
 * enabled) are the caller's job; this only checks the shape.
 */
export type CheckedWorkerMsg =
  | { ok: true; msg: JsWorkerToMainMsg }
  | {
      ok: false;
      reason: string;
      /**
       * Set for a malformed `cap-call` whose `callId` and `runId` are
       * usable, so the host can answer with an error `cap-result` instead
       * of leaving the guest's call hanging.
       */
      capCall?: { callId: number; runId: number };
    };

const ENTRY_TYPES: ReadonlySet<string> = new Set<OutputEntry['type']>([
  'log',
  'warn',
  'error',
  'result',
  'system',
]);

type Fields = Record<string, unknown>;

/** A non-null, non-array object. */
function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function reject(reason: string): CheckedWorkerMsg {
  return { ok: false, reason };
}

function checkEntry(value: unknown): OutputEntry | null {
  if (!isRecord(value)) return null;
  const { type, content, timestamp } = value;
  if (typeof type !== 'string' || !ENTRY_TYPES.has(type)) return null;
  if (typeof content !== 'string') return null;
  if (typeof timestamp !== 'number') return null;
  return { type: type as OutputEntry['type'], content, timestamp };
}

function capCallProblem({ callId, runId, capability, method, args }: Fields): string | null {
  if (!isId(callId)) return 'callId is not a number';
  if (!isId(runId)) return 'runId is not a number';
  if (typeof capability !== 'string') return 'capability is not a string';
  if (typeof method !== 'string') return 'method is not a string';
  if (!Array.isArray(args)) return 'args is not an array';
  return null;
}

function checkCapCall(m: Fields): CheckedWorkerMsg {
  const { callId, runId } = m;
  const problem = capCallProblem(m);
  if (problem === null) {
    return {
      ok: true,
      msg: {
        type: 'cap-call',
        callId: callId as number,
        runId: runId as number,
        capability: m['capability'] as string,
        method: m['method'] as string,
        args: m['args'] as unknown[],
      },
    };
  }
  const reason = `malformed cap-call: ${problem}`;
  return isId(callId) && isId(runId)
    ? { ok: false, reason, capCall: { callId, runId } }
    : reject(reason);
}

export function checkWorkerMessage(data: unknown): CheckedWorkerMsg {
  try {
    if (!isRecord(data)) return reject('not an object');
    switch (data['type']) {
      case 'ready':
        return { ok: true, msg: { type: 'ready' } };
      case 'init-error': {
        const { message } = data;
        if (typeof message !== 'string') return reject('malformed init-error');
        return { ok: true, msg: { type: 'init-error', message } };
      }
      case 'output': {
        const { runId } = data;
        const entry = checkEntry(data['entry']);
        if (!isId(runId) || !entry) return reject('malformed output');
        return { ok: true, msg: { type: 'output', runId, entry } };
      }
      case 'cap-call':
        return checkCapCall(data);
      case 'done': {
        const { runId, success, timedOut, error } = data;
        if (
          !isId(runId) ||
          typeof success !== 'boolean' ||
          typeof timedOut !== 'boolean' ||
          (error !== undefined && typeof error !== 'string')
        ) {
          return reject('malformed done');
        }
        return {
          ok: true,
          msg: {
            type: 'done',
            runId,
            success,
            timedOut,
            ...(error !== undefined ? { error } : {}),
          },
        };
      }
      default:
        return reject('unknown message type');
    }
  } catch {
    // A hostile getter (only possible without structured cloning).
    return reject('unreadable message');
  }
}
