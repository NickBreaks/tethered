import { checkWorkerMessage } from './check-worker-message.js';

describe('checkWorkerMessage', () => {
  it('A28: rejects anything that is not a plain object with a known type', () => {
    for (const data of [null, undefined, 'ready', 1, true, [], [{ type: 'ready' }], {}]) {
      expect(checkWorkerMessage(data).ok).toBe(false);
    }
  });

  it('A24: rejects unknown types, including inherited property names', () => {
    for (const type of ['pwn', 'toString', '__proto__', 42, null]) {
      expect(checkWorkerMessage({ type }).ok).toBe(false);
    }
  });

  it('never throws, even on a hostile getter', () => {
    const hostile = Object.defineProperty({}, 'type', {
      get() {
        throw new Error('boom');
      },
    });
    expect(checkWorkerMessage(hostile)).toEqual({ ok: false, reason: 'unreadable message' });
  });

  it('accepts well-formed messages and rebuilds them from known fields only', () => {
    expect(checkWorkerMessage({ type: 'ready', extra: 1 })).toEqual({
      ok: true,
      msg: { type: 'ready' },
    });
    expect(checkWorkerMessage({ type: 'init-error', message: 'no wasm' })).toEqual({
      ok: true,
      msg: { type: 'init-error', message: 'no wasm' },
    });
    expect(
      checkWorkerMessage({
        type: 'output',
        runId: 1,
        entry: { type: 'log', content: 'hi', timestamp: 2, html: '<b>' },
      }),
    ).toStrictEqual({
      ok: true,
      msg: { type: 'output', runId: 1, entry: { type: 'log', content: 'hi', timestamp: 2 } },
    });
    expect(
      checkWorkerMessage({
        type: 'cap-call',
        callId: 3,
        runId: 1,
        capability: 'fetch',
        method: 'request',
        args: ['u'],
      }),
    ).toEqual({
      ok: true,
      msg: {
        type: 'cap-call',
        callId: 3,
        runId: 1,
        capability: 'fetch',
        method: 'request',
        args: ['u'],
      },
    });
    expect(
      checkWorkerMessage({ type: 'done', runId: 1, success: false, timedOut: false, error: 'E' }),
    ).toEqual({
      ok: true,
      msg: { type: 'done', runId: 1, success: false, timedOut: false, error: 'E' },
    });
  });

  it('rejects a non-string init-error message', () => {
    expect(checkWorkerMessage({ type: 'init-error', message: 42 }).ok).toBe(false);
  });

  it('A25: rejects output with a missing, unknown-type or non-string-content entry', () => {
    for (const entry of [
      undefined,
      { content: 'x', timestamp: 1 },
      { type: 'shout', content: 'x', timestamp: 1 },
      { type: 'log', content: 1, timestamp: 1 },
      { type: 'log', content: 'x' },
    ]) {
      expect(checkWorkerMessage({ type: 'output', runId: 1, entry }).ok).toBe(false);
    }
  });

  it('A26: a malformed cap-call carries callId and runId when both are usable', () => {
    const base = { type: 'cap-call', callId: 7, runId: 2, capability: 'c', method: 'm', args: [] };
    expect(checkWorkerMessage({ ...base, args: 'x' })).toEqual({
      ok: false,
      reason: 'malformed cap-call: args is not an array',
      capCall: { callId: 7, runId: 2 },
    });
    expect(checkWorkerMessage({ ...base, method: 1 })).toMatchObject({
      ok: false,
      capCall: { callId: 7, runId: 2 },
    });
    expect(checkWorkerMessage({ ...base, callId: '7', args: 'x' })).toEqual({
      ok: false,
      reason: 'malformed cap-call: callId is not a number',
    });
    expect(checkWorkerMessage({ ...base, runId: null })).not.toHaveProperty('capCall');
  });

  it('A27: rejects done with a non-boolean success or timedOut, or a non-string error', () => {
    const base = { type: 'done', runId: 1, success: true, timedOut: false };
    expect(checkWorkerMessage(base).ok).toBe(true);
    expect(checkWorkerMessage({ ...base, success: 'true' }).ok).toBe(false);
    expect(checkWorkerMessage({ ...base, timedOut: undefined }).ok).toBe(false);
    expect(checkWorkerMessage({ ...base, error: 5 }).ok).toBe(false);
    expect(checkWorkerMessage({ ...base, runId: '1' }).ok).toBe(false);
  });

  it('accepts done with a boolean exhausted flag and keeps it', () => {
    const base = { type: 'done', runId: 1, success: false, timedOut: false, error: 'E' };
    expect(checkWorkerMessage({ ...base, exhausted: true, extra: 1 })).toEqual({
      ok: true,
      msg: { ...base, exhausted: true },
    });
    expect(checkWorkerMessage({ ...base, exhausted: false })).toEqual({
      ok: true,
      msg: { ...base, exhausted: false },
    });
    expect(checkWorkerMessage(base)).toEqual({ ok: true, msg: base });
  });

  it('rejects done with a non-boolean exhausted flag', () => {
    const base = { type: 'done', runId: 1, success: false, timedOut: false };
    for (const exhausted of ['true', 1, null, {}]) {
      expect(checkWorkerMessage({ ...base, exhausted }).ok).toBe(false);
    }
  });
});
