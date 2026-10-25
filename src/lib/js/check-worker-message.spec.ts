import { checkWorkerMessage } from './check-worker-message.js';

describe('checkWorkerMessage', () => {
  it.each([
    ['null', null, 'not an object'],
    ['undefined', undefined, 'not an object'],
    ['a string', 'ready', 'not an object'],
    ['a number', 1, 'not an object'],
    ['a boolean', true, 'not an object'],
    ['an empty array', [], 'not an object'],
    ['an array that holds a message', [{ type: 'ready' }], 'not an object'],
    ['an object without type', {}, 'unknown message type'],
  ])('rejects %s', (_name, data, reason) => {
    expect(checkWorkerMessage(data)).toStrictEqual({ ok: false, reason });
  });

  it.each(['pwn', 'toString', '__proto__', 42, null])(
    'rejects the unknown type %j, including inherited property names',
    (type) => {
      expect(checkWorkerMessage({ type })).toStrictEqual({
        ok: false,
        reason: 'unknown message type',
      });
    },
  );

  it('never throws, even on a hostile getter', () => {
    const hostile = Object.defineProperty({}, 'type', {
      get() {
        throw new Error('boom');
      },
    });
    expect(checkWorkerMessage(hostile)).toStrictEqual({ ok: false, reason: 'unreadable message' });
  });

  // toStrictEqual also fails on a key with the value undefined. Thus each
  // row shows that the rebuilt message has only the known fields.
  it.each([
    ['ready', { type: 'ready', extra: 1 }, { type: 'ready' }],
    [
      'init-error',
      { type: 'init-error', message: 'no wasm', extra: 1 },
      { type: 'init-error', message: 'no wasm' },
    ],
    [
      'output',
      {
        type: 'output',
        runId: 1,
        entry: { type: 'log', content: 'hi', timestamp: 2, html: '<b>' },
        extra: 1,
      },
      { type: 'output', runId: 1, entry: { type: 'log', content: 'hi', timestamp: 2 } },
    ],
    [
      'cap-call',
      {
        type: 'cap-call',
        callId: 3,
        runId: 1,
        capability: 'fetch',
        method: 'request',
        args: ['u'],
        extra: 1,
      },
      {
        type: 'cap-call',
        callId: 3,
        runId: 1,
        capability: 'fetch',
        method: 'request',
        args: ['u'],
      },
    ],
    [
      'done',
      { type: 'done', runId: 1, success: false, timedOut: false, error: 'E', extra: 1 },
      { type: 'done', runId: 1, success: false, timedOut: false, error: 'E' },
    ],
    [
      'done without error',
      { type: 'done', runId: 1, success: true, timedOut: false },
      { type: 'done', runId: 1, success: true, timedOut: false },
    ],
  ])(
    'accepts a well-formed %s message and rebuilds it from known fields only',
    (_name, data, msg) => {
      expect(checkWorkerMessage(data)).toStrictEqual({ ok: true, msg });
    },
  );

  it('rejects a non-string init-error message', () => {
    expect(checkWorkerMessage({ type: 'init-error', message: 42 })).toStrictEqual({
      ok: false,
      reason: 'malformed init-error',
    });
  });

  it.each([
    ['a missing entry', undefined],
    ['an entry that is not an object', 'log'],
    ['an entry without type', { content: 'x', timestamp: 1 }],
    ['an entry with an unknown type', { type: 'shout', content: 'x', timestamp: 1 }],
    ['an entry with non-string content', { type: 'log', content: 1, timestamp: 1 }],
    ['an entry without timestamp', { type: 'log', content: 'x' }],
  ])('rejects output with %s', (_name, entry) => {
    expect(checkWorkerMessage({ type: 'output', runId: 1, entry })).toStrictEqual({
      ok: false,
      reason: 'malformed output',
    });
  });

  it('rejects output with a runId that is not a number', () => {
    const entry = { type: 'log', content: 'x', timestamp: 1 };
    expect(checkWorkerMessage({ type: 'output', runId: '1', entry })).toStrictEqual({
      ok: false,
      reason: 'malformed output',
    });
  });

  describe('a malformed cap-call carries callId and runId when both are usable', () => {
    const base = { type: 'cap-call', callId: 7, runId: 2, capability: 'c', method: 'm', args: [] };

    it.each([
      ['args is not an array', { args: 'x' }],
      ['method is not a string', { method: 1 }],
      ['capability is not a string', { capability: undefined }],
    ])('%s: the rejection carries the ids', (problem, change) => {
      expect(checkWorkerMessage({ ...base, ...change })).toStrictEqual({
        ok: false,
        reason: `malformed cap-call: ${problem}`,
        capCall: { callId: 7, runId: 2 },
      });
    });

    it.each([
      // The first problem is the reason, also when there is more than one.
      ['callId is not a number', { callId: '7', args: 'x' }],
      ['runId is not a number', { runId: null }],
      ['runId is not a number', { runId: Number.NaN, method: 1 }],
    ])('%s: the rejection has no ids (%j)', (problem, change) => {
      expect(checkWorkerMessage({ ...base, ...change })).toStrictEqual({
        ok: false,
        reason: `malformed cap-call: ${problem}`,
      });
    });
  });

  describe('done', () => {
    const base = { type: 'done', runId: 1, success: true, timedOut: false };

    it('accepts done with boolean success and timedOut', () => {
      expect(checkWorkerMessage(base)).toStrictEqual({ ok: true, msg: base });
    });

    it.each([
      ['a non-boolean success', { success: 'true' }],
      ['a missing timedOut', { timedOut: undefined }],
      ['a non-string error', { error: 5 }],
      ['a string runId', { runId: '1' }],
      ['an infinite runId', { runId: Infinity }],
    ])('rejects done with %s', (_name, change) => {
      expect(checkWorkerMessage({ ...base, ...change })).toStrictEqual({
        ok: false,
        reason: 'malformed done',
      });
    });

    it.each([true, false])('accepts done with exhausted: %s and keeps it', (exhausted) => {
      const failed = { ...base, success: false, error: 'E' };
      expect(checkWorkerMessage({ ...failed, exhausted, extra: 1 })).toStrictEqual({
        ok: true,
        msg: { ...failed, exhausted },
      });
    });

    it.each(['true', 1, null, {}])(
      'rejects done with the non-boolean exhausted flag %j',
      (exhausted) => {
        expect(checkWorkerMessage({ ...base, exhausted })).toStrictEqual({
          ok: false,
          reason: 'malformed done',
        });
      },
    );

    it.each([true, false])('accepts done with broken: %s and keeps it', (broken) => {
      const failed = { ...base, success: false, error: 'E' };
      expect(checkWorkerMessage({ ...failed, broken, extra: 1 })).toStrictEqual({
        ok: true,
        msg: { ...failed, broken },
      });
    });

    it.each(['true', 1, null, {}])('rejects done with the non-boolean broken flag %j', (broken) => {
      expect(checkWorkerMessage({ ...base, broken })).toStrictEqual({
        ok: false,
        reason: 'malformed done',
      });
    });
  });
});
