import { vi } from 'vitest';
import { createJsWorkerFactory } from '../../workers/index.js';
import { JsRunner } from './js-runner.js';
import { CapabilityStore } from '../capabilities/capability-store.js';
import { FetchCapability } from '../capabilities/fetch-capability.js';
import type { ProxyAuth } from '../proxy/proxy-auth.js';
import { StorageCapability, MapStorageBackend } from '../capabilities/storage-capability.js';
import { DiskCapability, MapDiskBackend } from '../capabilities/disk-capability.js';
import { TimerCapability } from '../capabilities/timer-capability.js';
import type { SandboxCapability } from '../capabilities/capability.js';
import type { OutputEntry } from '../shared/sandbox-types.js';
import { MAX_ERROR_CHARS, OUTPUT_ENTRY_COST } from './worker-protocol.js';

const stubProxyAuth = {
  proxyBase: () => null,
  authHeader: () => null,
  setToken: vi.fn(),
  clearToken: vi.fn(),
  invalidate: vi.fn(),
  tokenInvalid: () => false,
} as unknown as ProxyAuth;

const TIMEOUT_TEXT = 'Execution timed out: script exceeded the time limit.';
const ABORT_TEXT = 'Execution aborted.';

const logsOf = (output: OutputEntry[]) =>
  output.filter((e) => e.type === 'log').map((e) => e.content);
const resultsOf = (output: OutputEntry[]) =>
  output.filter((e) => e.type === 'result').map((e) => e.content);

/** Waits for real time, so that a run can reach a hot loop or a host call. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('JsRunner', () => {
  let service: JsRunner;
  let registry: CapabilityStore;

  beforeAll(async () => {
    registry = new CapabilityStore();
    // jsdom has no Worker: opt in to the in-process host.
    service = new JsRunner(registry, {
      workerFactory: createJsWorkerFactory({ allowInProcess: true }),
    });
    await service.initialize();

    registry.register(new FetchCapability(stubProxyAuth));
    registry.register(new StorageCapability(new MapStorageBackend()));
    registry.register(new DiskCapability(new MapDiskBackend()));
    registry.register(new TimerCapability());
  });

  // All tests share one runner. Reset the state that a test can change.
  afterEach(() => {
    for (const cap of registry.getAll()) registry.setEnabled(cap.name, false);
    service.timeoutMs = 5000;
  });

  afterAll(() => {
    service.dispose();
  });

  // Test 18: After initialize(), ready() returns true
  it('should be ready after initialization', () => {
    expect(service.ready.get()).toBe(true);
  });

  // Test 1: execute("1 + 1") returns success with result entry "2"
  it('should execute simple expression and return result', async () => {
    const result = await service.execute('1 + 1');
    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(resultsOf(result.output)).toEqual(['2']);
  });

  // Tests 2, 3 and 4: each console method produces an entry of its type
  it.each([
    ['log', 'hello'],
    ['warn', 'caution'],
    ['error', 'fail'],
  ] as const)('should capture console.%s output', async (method, text) => {
    const result = await service.execute(`console.${method}(${JSON.stringify(text)})`);
    expect(result.success).toBe(true);
    expect(result.output).toContainEqual(expect.objectContaining({ type: method, content: text }));
  });

  // Test 5: Multiple console calls produce entries in order
  it('should produce multiple entries in order', async () => {
    const result = await service.execute(
      'console.log("first"); console.warn("second"); console.error("third")',
    );
    expect(result.success).toBe(true);
    expect(result.output.length).toBeGreaterThanOrEqual(4);
    expect(result.output[1]).toEqual(expect.objectContaining({ type: 'log', content: 'first' }));
    expect(result.output[2]).toEqual(expect.objectContaining({ type: 'warn', content: 'second' }));
    expect(result.output[3]).toEqual(expect.objectContaining({ type: 'error', content: 'third' }));
  });

  // Test 6: console.log("a", 1, true) produces "a 1 true"
  it('should join multiple console.log arguments with spaces', async () => {
    const result = await service.execute('console.log("a", 1, true)');
    expect(logsOf(result.output)).toEqual(['a 1 true']);
  });

  // Test 7: console.log({x: 1}) produces JSON-formatted content
  it('should JSON-stringify object arguments', async () => {
    const result = await service.execute('console.log({x: 1})');
    expect(result.output).toContainEqual(
      expect.objectContaining({ type: 'log', content: expect.stringContaining('"x": 1') }),
    );
  });

  // Tests 8, 9 and 10: guest errors fail the run with an error entry
  it.each([
    ['ReferenceError', 'unknownVar'],
    ['TypeError', 'null.foo'],
    ['SyntaxError', 'if ('],
  ])('should return error for %s', async (name, code) => {
    const result = await service.execute(code);
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContainEqual(
      expect.objectContaining({ type: 'error', content: expect.stringContaining(name) }),
    );
  });

  // Test 11: Thrown primitive
  it('should handle thrown primitives', async () => {
    const result = await service.execute("throw 'oops'");
    expect(result.success).toBe(false);
    expect(result.output).toContainEqual(
      expect.objectContaining({ type: 'error', content: expect.stringContaining('oops') }),
    );
  });

  // Test 12: Timeout
  it('should timeout on infinite loops', async () => {
    service.timeoutMs = 100;
    const result = await service.execute('while(true){}');
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toBe(TIMEOUT_TEXT);
    expect(result.output).toContainEqual(
      expect.objectContaining({ type: 'system', content: TIMEOUT_TEXT }),
    );
  }, 10000);

  // Tests 13, 14 and 16: the guest has no browser globals
  it.each(['window', 'document', 'localStorage'])('should not expose %s', async (name) => {
    const result = await service.execute(`typeof ${name}`);
    expect(result.success).toBe(true);
    expect(resultsOf(result.output)).toEqual(['undefined']);
  });

  // Test 15: fetch stub throws descriptive error when capability is disabled
  it('should throw error for disabled fetch capability', async () => {
    const result = await service.execute(`
      try {
        fetch('http://example.com');
        'no error';
      } catch (e) {
        e.message;
      }
    `);
    expect(result.success).toBe(true);
    expect(resultsOf(result.output)).toEqual([expect.stringContaining('fetch is not available')]);
  });

  // Test 17: No state leakage between runs
  it('should not leak state between executions', async () => {
    const r1 = await service.execute('var x = 42; x');
    expect(resultsOf(r1.output)).toEqual(['42']);
    const result = await service.execute('typeof x');
    expect(result.success).toBe(true);
    expect(resultsOf(result.output)).toEqual(['undefined']);
  });

  describe('Phase 3: Capabilities', () => {
    // Test 33: Enabled capability is available in sandbox
    it('should expose fetch as function when enabled', async () => {
      registry.setEnabled('fetch', true);
      const result = await service.execute('typeof fetch');
      expect(result.success).toBe(true);
      expect(resultsOf(result.output)).toEqual(['function']);
    });

    // Test 34: Multiple capabilities enabled simultaneously
    it('should support multiple capabilities in same execution', async () => {
      registry.setEnabled('storage', true);
      registry.setEnabled('disk', true);
      const result = await service.execute(`
        storage.setItem('key', 'val');
        var s = storage.getItem('key');
        disk.writeFile('/f.txt', 'hi');
        var d = disk.readFile('/f.txt');
        s + ':' + d;
      `);
      expect(result.success).toBe(true);
      expect(resultsOf(result.output)).toEqual(['val:hi']);
    });

    // Test 35: Config change between executions takes effect
    it('should apply config changes between executions', async () => {
      registry.setEnabled('storage', true);
      const r1 = await service.execute(`storage.setItem('k', 'v'); storage.getItem('k')`);
      expect(r1.success).toBe(true);
      expect(resultsOf(r1.output)).toEqual(['v']);

      registry.setEnabled('storage', false);
      const r2 = await service.execute(`
        try { storage.getItem('k'); 'no error'; } catch(e) { e.message; }
      `);
      expect(r2.success).toBe(true);
      expect(resultsOf(r2.output)).toEqual([
        expect.stringContaining('storage.getItem() is not available'),
      ]);
    });

    // Test 36: Console works alongside capabilities (regression)
    it('should support console alongside capabilities', async () => {
      registry.setEnabled('fetch', true);
      const result = await service.execute('console.log("hello"); 42');
      expect(result.success).toBe(true);
      expect(logsOf(result.output)).toEqual(['hello']);
      expect(resultsOf(result.output)).toEqual(['42']);
    });

    // Test 37: Timeout works with asyncify (regression)
    it('should timeout with capabilities enabled', async () => {
      registry.setEnabled('fetch', true);
      service.timeoutMs = 100;
      const result = await service.execute('while(true){}');
      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.error).toBe(TIMEOUT_TEXT);
    }, 10000);

    // Test 38: Custom capability without modifying JsRunner (extensibility).
    // Custom capabilities are host-backed: the worker injects a bridge
    // function per stubInfo entry and relays calls to invokeHost here.
    it('should support custom capabilities without modifying JsRunner', async () => {
      const invokeHost = vi.fn(async () => 'custom-works');
      const customCap: SandboxCapability = {
        name: 'testGlobal',
        description: 'A test capability',
        stubInfo: { name: 'testGlobal', type: 'function' },
        invokeHost,
      };
      registry.register(customCap);
      registry.setEnabled('testGlobal', true);

      const result = await service.execute('testGlobal(1, "a")');
      expect(result.success).toBe(true);
      expect(resultsOf(result.output)).toEqual(['custom-works']);
      expect(invokeHost).toHaveBeenCalledWith('testGlobal', [1, 'a'], {
        signal: expect.any(AbortSignal),
      });
    });

    // A capability can throw any value. The runner must always reply, so
    // the guest gets an error at once and does not wait for the backstop.
    describe('host call errors that do not convert to a string', () => {
      const badMessage = (get: () => unknown) => {
        const e = new Error('x');
        Object.defineProperty(e, 'message', { get });
        return e;
      };
      it.each([
        ['a null-prototype object', () => Object.create(null) as unknown],
        [
          'an Error with a message getter that throws',
          () =>
            badMessage(() => {
              throw new Error('getter');
            }),
        ],
        ['an Error with a message that is not a string', () => badMessage(() => 42)],
        [
          'an object whose toString throws',
          () => ({
            toString() {
              throw new Error('toString');
            },
          }),
        ],
      ])('replies "host call failed" for %s', async (_label, make) => {
        registry.register({
          name: 'boom',
          description: 'throws a bad value',
          stubInfo: { name: 'boom', type: 'function' },
          invokeHost: async () => {
            throw make();
          },
        });
        registry.setEnabled('boom', true);
        service.timeoutMs = 3000;
        const t0 = Date.now();
        const result = await service.execute(
          '(async () => { try { await boom(); return "no error"; } catch (e) { return e.message; } })()',
        );
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(result.success).toBe(true);
        expect(resultsOf(result.output)).toEqual(['host call failed']);
      });

      it('cuts a long host error message to MAX_ERROR_CHARS', async () => {
        registry.register({
          name: 'boom',
          description: 'throws a long message',
          stubInfo: { name: 'boom', type: 'function' },
          invokeHost: async () => {
            throw new Error('a'.repeat(MAX_ERROR_CHARS + 500));
          },
        });
        registry.setEnabled('boom', true);
        const result = await service.execute(
          '(async () => { try { await boom(); } catch (e) { return e.message.length; } })()',
        );
        expect(resultsOf(result.output)).toEqual([String(MAX_ERROR_CHARS)]);
      });
    });

    // Test 39: System message shows enabled capabilities
    it('should emit system message with enabled capabilities', async () => {
      registry.setEnabled('fetch', true);
      registry.setEnabled('storage', true);
      const result = await service.execute('1');
      expect(result.output[0]).toEqual(
        expect.objectContaining({ type: 'system', content: '[fetch, storage enabled]' }),
      );
    });

    // Test 40: System message shows no capabilities when none enabled
    it('should emit system message when no capabilities enabled', async () => {
      const result = await service.execute('1');
      expect(result.output[0]).toEqual(
        expect.objectContaining({ type: 'system', content: '[no capabilities enabled]' }),
      );
    });
  });

  describe('Phase 4: Timer Capability', () => {
    // A run that used real time would take at least 5000 ms. This limit
    // is well below that, but it gives a slow machine a large margin.
    const VIRTUAL_TIME_LIMIT_MS = 2500;

    beforeEach(() => {
      registry.setEnabled('timer', true);
    });

    // T5: setTimeout fires basic callback
    it('should fire setTimeout callback and capture console output', async () => {
      const result = await service.execute(`setTimeout(() => console.log('fired'), 0)`);
      expect(result.success).toBe(true);
      expect(logsOf(result.output)).toEqual(['fired']);
    });

    // T6: Timer callback warn/error produce correct output types
    it('should capture warn/error output from timer callbacks', async () => {
      const result = await service.execute(`
        setTimeout(() => console.warn('w'), 0);
        setTimeout(() => console.error('e'), 0);
      `);
      expect(result.success).toBe(true);
      expect(result.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'warn', content: 'w' }),
          expect.objectContaining({ type: 'error', content: 'e' }),
        ]),
      );
    });

    // T7, T8, T9, T10, T11 and T13: the order of timer callbacks.
    it.each([
      [
        'should fire setTimeouts in registration order at delay 0',
        `
        setTimeout(() => console.log('a'), 0);
        setTimeout(() => console.log('b'), 0);
        setTimeout(() => console.log('c'), 0);
        `,
        ['a', 'b', 'c'],
      ],
      [
        'should fire setInterval until clearInterval is called',
        `
        let count = 0;
        const id = setInterval(() => {
          count++;
          console.log('tick:' + count);
          if (count === 3) clearInterval(id);
        }, 10);
        `,
        ['tick:1', 'tick:2', 'tick:3'],
      ],
      [
        'should cancel callback when clearTimeout is called before drain',
        `
        const a = setTimeout(() => console.log('a'), 100);
        const b = setTimeout(() => console.log('b'), 100);
        clearTimeout(a);
        `,
        ['b'],
      ],
      [
        'should allow clearTimeout from inside a timer callback',
        `
        const b = setTimeout(() => console.log('b'), 200);
        setTimeout(() => {
          console.log('a');
          clearTimeout(b);
        }, 50);
        `,
        ['a'],
      ],
      [
        'should fire nested setTimeout callbacks',
        `
        setTimeout(() => {
          console.log('outer');
          setTimeout(() => console.log('inner'), 0);
        }, 0);
        `,
        ['outer', 'inner'],
      ],
      [
        'should interleave promise chain with timer callbacks',
        `
        Promise.resolve()
          .then(() => console.log('m1'))
          .then(() => new Promise(r => setTimeout(r, 0)))
          .then(() => console.log('m2'));
        `,
        ['m1', 'm2'],
      ],
    ])('%s', async (_name, code, logs) => {
      const result = await service.execute(code);
      expect(result.success).toBe(true);
      expect(logsOf(result.output)).toEqual(logs);
    });

    // T12: Promise + setTimeout
    it('should resolve promises wrapping setTimeout', async () => {
      const result = await service.execute(`
        new Promise(r => setTimeout(r, 0)).then(() => console.log('p'));
      `);
      expect(result.success).toBe(true);
      expect(logsOf(result.output)).toEqual(['p']);
    });

    // T14: setTimeout fires via virtual time advancement (not real wait)
    it('should fire delayed setTimeout via virtual time without real-time wait', async () => {
      const t0 = Date.now();
      const result = await service.execute(`setTimeout(() => console.log('done'), 5000)`);
      const elapsed = Date.now() - t0;
      expect(result.success).toBe(true);
      expect(elapsed).toBeLessThan(VIRTUAL_TIME_LIMIT_MS);
      expect(logsOf(result.output)).toEqual(['done']);
    });

    // T15: setInterval fires multiple times via virtual time
    it('should fire setInterval multiple times via virtual time', async () => {
      const t0 = Date.now();
      const result = await service.execute(`
        let n = 0;
        const id = setInterval(() => {
          n++;
          console.log('n:' + n);
          if (n === 5) clearInterval(id);
        }, 1000);
      `);
      const elapsed = Date.now() - t0;
      expect(result.success).toBe(true);
      expect(elapsed).toBeLessThan(VIRTUAL_TIME_LIMIT_MS);
      expect(logsOf(result.output)).toEqual(['n:1', 'n:2', 'n:3', 'n:4', 'n:5']);
    });

    // T20 and T21: Runaway interval with short timeout, with the same
    // system message as a hot-loop timeout
    it('should time out a runaway setInterval with the standard timeout message', async () => {
      service.timeoutMs = 100;
      const result = await service.execute(`setInterval(() => {}, 1)`);
      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.output).toContainEqual(
        expect.objectContaining({ type: 'system', content: TIMEOUT_TEXT }),
      );
    }, 10000);

    // T22: Disabled — all four globals throw
    it('should throw descriptive errors for all four timer globals when disabled', async () => {
      registry.setEnabled('timer', false);
      const names = ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'];
      const result = await service.execute(`
        const errs = [];
        for (const name of ${JSON.stringify(names)}) {
          try { globalThis[name](() => {}, 0); errs.push(name + ':no-error'); }
          catch (e) { errs.push(name + ':' + e.message); }
        }
        errs.join('|');
      `);
      expect(result.success).toBe(true);
      expect(resultsOf(result.output)).toEqual([
        names
          .map((n) => `${n}:${n} is not available: the 'timer' capability is not enabled.`)
          .join('|'),
      ]);
    });

    // T24: Invalid IDs to clearTimeout/clearInterval
    it('should no-op on clearTimeout/clearInterval with invalid IDs', async () => {
      const result = await service.execute(`
        clearTimeout(99999);
        clearInterval(99999);
        'ok';
      `);
      expect(result.success).toBe(true);
      expect(resultsOf(result.output)).toEqual(['ok']);
    });

    // T25: State isolation across executions
    it('should not see timers from a previous execute() call', async () => {
      // A top-level throw ends the run before the event loop runs. Thus the
      // timer of the first run is still pending when the run ends.
      const r1 = await service.execute(`
        setTimeout(() => console.log('first'), 0);
        throw new Error('stop');
      `);
      expect(r1.success).toBe(false);
      expect(logsOf(r1.output)).toEqual([]);
      const r2 = await service.execute(`setTimeout(() => console.log('second'), 0)`);
      expect(r2.success).toBe(true);
      expect(logsOf(r2.output)).toEqual(['second']);
    });

    // T26: Timer IDs reset on new execute() call
    it('should reset timer IDs on each execute() call', async () => {
      const r1 = await service.execute(`setTimeout(() => {}, 100)`);
      const r2 = await service.execute(`setTimeout(() => {}, 100)`);
      // Both runs must get the first ID (1). This shows a fresh state.
      expect(resultsOf(r1.output)).toEqual(['1']);
      expect(resultsOf(r2.output)).toEqual(['1']);
    });

    // T18: System message includes 'timer'
    it('should include timer in the system message when enabled', async () => {
      const result = await service.execute('1');
      expect(result.output[0]).toEqual(
        expect.objectContaining({ type: 'system', content: '[timer enabled]' }),
      );
    });

    // T19: Disabled then enabled then run
    it('should reflect timer config changes between executions', async () => {
      // Disabled: throws
      registry.setEnabled('timer', false);
      const r1 = await service.execute(`
        try { setTimeout(() => {}, 0); 'no-error'; } catch (e) { e.message; }
      `);
      expect(r1.success).toBe(true);
      expect(resultsOf(r1.output)).toEqual([expect.stringContaining('not available')]);

      // Enabled: succeeds
      registry.setEnabled('timer', true);
      const r2 = await service.execute(`setTimeout(() => console.log('ok'), 0)`);
      expect(r2.success).toBe(true);
      expect(logsOf(r2.output)).toEqual(['ok']);
    });

    // T29: 100 setTimeouts all fire
    it('should fire 100 setTimeouts at delay 0', async () => {
      const result = await service.execute(`
        let count = 0;
        for (let i = 0; i < 100; i++) {
          setTimeout(() => count++, 0);
        }
        // Schedule a final timer to read the count after all others fire
        setTimeout(() => console.log('done:' + count), 1);
      `);
      expect(result.success).toBe(true);
      expect(logsOf(result.output)).toEqual(['done:100']);
    });

    it('fires top-level timers in due-time order on one virtual clock', async () => {
      const result = await service.execute(`
        setTimeout(() => console.log('A'), 5000);
        setTimeout(() => {
          console.log('B');
          setTimeout(() => console.log('C'), 10);
        }, 0);
      `);
      expect(result.success).toBe(true);
      expect(logsOf(result.output)).toEqual(['B', 'C', 'A']);
    }, 10_000);

    it('counts setInterval ticks against a top-level setTimeout on the same clock', async () => {
      const result = await service.execute(`
        let n = 0;
        const id = setInterval(() => n++, 1000);
        setTimeout(() => { clearInterval(id); console.log(n); }, 5500);
      `);
      expect(result.success).toBe(true);
      expect(logsOf(result.output)).toEqual(['5']);
    }, 10_000);

    it('reports the settled value of an async top-level promise that waits on a timer', async () => {
      const result = await service.execute(`
        (async () => {
          await new Promise((r) => setTimeout(r, 1000));
          return 'late';
        })()
      `);
      expect(result.success).toBe(true);
      expect(resultsOf(result.output)).toEqual(['late']);
    }, 10_000);
  });

  describe('Promise jobs without the timer capability', () => {
    it('runs promise jobs after the top-level eval', async () => {
      const result = await service.execute(`
        Promise.resolve().then(() => console.log('x'));
        console.log('first');
      `);
      expect(result.success).toBe(true);
      expect(logsOf(result.output)).toEqual(['first', 'x']);
    }, 10_000);

    it('reports the settled value of an async top-level IIFE, not a pending promise', async () => {
      const result = await service.execute(`
        (async () => {
          await null;
          await Promise.resolve();
          return { answer: 42 };
        })()
      `);
      expect(result.success).toBe(true);
      expect(resultsOf(result.output)).toEqual([JSON.stringify({ answer: 42 }, null, 2)]);
    }, 10_000);

    it('reports the value of a top-level promise that is already fulfilled', async () => {
      const result = await service.execute('Promise.resolve(5)');
      expect(result.success).toBe(true);
      expect(resultsOf(result.output)).toEqual(['5']);
    }, 10_000);

    it('fails the run when the top-level promise rejects', async () => {
      const result = await service.execute(`(async () => { throw new Error('boom'); })()`);
      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.error).toMatch(/^Error: boom/);
      expect(result.output).toContainEqual(
        expect.objectContaining({ type: 'error', content: expect.stringMatching(/^Error: boom/) }),
      );
    }, 10_000);

    it('gives no result for a top-level promise that can never settle', async () => {
      const result = await service.execute('new Promise(() => {})');
      expect(result.success).toBe(true);
      expect(resultsOf(result.output)).toEqual([]);
    }, 10_000);

    it('times out a promise chain that never ends', async () => {
      service.timeoutMs = 200;
      const result = await service.execute('function f() { Promise.resolve().then(f) } f()');
      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
    }, 10_000);
  });

  // CodeRunner conformance
  describe('CodeRunner conformance', () => {
    // Test 19: running() transitions
    it('isRunning is true while a run is in flight and false after it settles', async () => {
      // This run waits for a respawn that an earlier test can leave in
      // flight. Then the worker is ready, and the next execute() posts its
      // run synchronously.
      await service.execute('0');
      expect(service.isRunning.get()).toBe(false);
      const p = service.execute('1 + 1');
      expect(service.isRunning.get()).toBe(true);
      const result = await p;
      expect(result.success).toBe(true);
      expect(service.isRunning.get()).toBe(false);
    });

    it('initError is null after a successful boot', () => {
      expect(service.initError.get()).toBeNull();
    });

    it('abort() before execute is a silent no-op', async () => {
      await expect(service.abort()).resolves.toBeUndefined();
      // Subsequent execute still succeeds.
      const result = await service.execute('1 + 1');
      expect(result.success).toBe(true);
    });

    // The tests for abort() during a run are in the next describe block.
    // The in-process host runs a hot loop on the test thread, so abort()
    // cannot stop it here. The abort spec in js-worker.integration.spec.ts tests that
    // case with a real Worker.
  });

  // Worker-based abort: abort() terminates the worker and respawns it,
  // so it must end runs that the old in-thread cancel flag could not end.
  // The most important are runs suspended on a pending host capability
  // call (the "abort during fetch" case).
  describe('Worker-based abort (terminate + respawn)', () => {
    const hangCap: SandboxCapability = {
      name: 'hang',
      description: 'host call that never resolves',
      stubInfo: { name: 'hang', type: 'function' },
      invokeHost: () => new Promise<never>(() => {}),
    };

    beforeAll(() => {
      registry.register(hangCap);
    });

    it('abort() promptly ends a run suspended on a pending host call', async () => {
      registry.setEnabled('hang', true);
      const p = service.execute('hang()');
      // Let the run reach the never-resolving host call.
      await sleep(50);
      expect(service.isRunning.get()).toBe(true);
      const t0 = Date.now();
      await service.abort();
      const result = await p;
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.error).toBe(ABORT_TEXT);
      expect(result.output).toContainEqual(
        expect.objectContaining({ type: 'system', content: ABORT_TEXT }),
      );
      expect(service.isRunning.get()).toBe(false);
    }, 10000);

    it('preserves output emitted before the abort', async () => {
      registry.setEnabled('hang', true);
      const p = service.execute('console.log("partial"); hang()');
      await sleep(50);
      await service.abort();
      const result = await p;
      expect(result.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'log', content: 'partial' }),
          expect.objectContaining({ type: 'system', content: ABORT_TEXT }),
        ]),
      );
    }, 10000);

    it('execute() works again after abort() (worker respawned)', async () => {
      registry.setEnabled('hang', true);
      const p = service.execute('hang()');
      await sleep(50);
      await service.abort();
      expect((await p).error).toBe(ABORT_TEXT);
      registry.setEnabled('hang', false);
      const result = await service.execute('40 + 2');
      expect(result.success).toBe(true);
      expect(resultsOf(result.output)).toEqual(['42']);
    }, 10000);

    it('backstop timeout ends a run stuck in a pending host call', async () => {
      registry.setEnabled('hang', true);
      service.timeoutMs = 100;
      const result = await service.execute('hang()');
      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.output).toContainEqual(
        expect.objectContaining({ type: 'system', content: TIMEOUT_TEXT }),
      );
    }, 10000);
  });

  // The real engine end to end (the fake-worker variants live in
  // js-runner-options.spec.ts).
  describe('activeTag and onOutput (real QuickJS)', () => {
    let seenTag: string | null | undefined;
    const whoami: SandboxCapability = {
      name: 'whoami',
      description: 'returns the active run tag',
      stubInfo: { name: 'whoami', type: 'function' },
      invokeHost: async () => {
        seenTag = service.activeTag.get();
        return seenTag;
      },
    };

    beforeAll(() => {
      registry.register(whoami);
    });

    it('a host capability sees the run tag; it is null after the run', async () => {
      seenTag = undefined;
      registry.setEnabled('whoami', true);
      const result = await service.execute('whoami()', { tag: 'claude' });
      expect(seenTag).toBe('claude');
      expect(result.success).toBe(true);
      expect(result.output.at(-1)).toEqual(expect.objectContaining({ type: 'result' }));
      expect(result.output.at(-1)?.content).toContain('claude');
      expect(service.activeTag.get()).toBeNull();
    });

    it('onOutput streams the same entries the result carries, before it resolves', async () => {
      const streamed: OutputEntry[] = [];
      const off = service.onOutput((e) => streamed.push(e));
      let streamedAtSettle = -1;
      const result = await service
        .execute('console.log("one"); console.log("two"); 3')
        .then((r) => {
          streamedAtSettle = streamed.length;
          return r;
        });
      off();
      expect(streamed).toEqual(result.output);
      expect(streamedAtSettle).toBe(result.output.length);
      expect(streamed.map((e) => e.content)).toEqual(expect.arrayContaining(['one', 'two', '3']));
    });
  });
});

describe('JsRunner output limit (in-process worker)', () => {
  let runner: JsRunner;

  beforeAll(async () => {
    runner = new JsRunner(new CapabilityStore(), {
      workerFactory: createJsWorkerFactory({ allowInProcess: true }),
      // Three entries of 30 characters fit. A fourth entry does not fit.
      maxOutputChars: 100 + 3 * OUTPUT_ENTRY_COST,
    });
    await runner.initialize();
  });

  afterAll(() => {
    runner.dispose();
  });

  it('keeps the output in the limit, adds one system entry and the run continues', async () => {
    const streamed: OutputEntry[] = [];
    const off = runner.onOutput((e) => streamed.push(e));
    const result = await runner.execute(`
      let n = 0;
      for (let i = 0; i < 1000; i++) { console.log('x'.repeat(30)); n++; }
      n
    `);
    off();
    expect(result.success).toBe(true);
    expect(result.output.map((e) => e.type)).toEqual(['system', 'log', 'log', 'log', 'system']);
    expect(result.output.at(-1)?.content).toBe(
      `Output limit reached (${100 + 3 * OUTPUT_ENTRY_COST} characters). The runner dropped the remaining output.`,
    );
    expect(streamed).toEqual(result.output);
  });

  it('gives the next run a new limit', async () => {
    const result = await runner.execute("console.log('ok'); 1 + 1");
    expect(logsOf(result.output)).toEqual(['ok']);
    expect(resultsOf(result.output)).toEqual(['2']);
  });
});

describe('JsRunner default output limit (in-process worker)', () => {
  let runner: JsRunner;

  beforeAll(async () => {
    runner = new JsRunner(new CapabilityStore(), {
      workerFactory: createJsWorkerFactory({ allowInProcess: true }),
      timeoutMs: 1000,
    });
    await runner.initialize();
  });

  afterAll(() => {
    runner.dispose();
  });

  it('keeps a maximum of maxOutputChars / OUTPUT_ENTRY_COST empty entries', async () => {
    const streamed: OutputEntry[] = [];
    const off = runner.onOutput((e) => streamed.push(e));
    const result = await runner.execute('for (;;) console.log()');
    off();
    expect(result.timedOut).toBe(true);
    const max = Math.floor(1_048_576 / OUTPUT_ENTRY_COST);
    expect(logsOf(result.output).length).toBeLessThanOrEqual(max);
    expect(logsOf(streamed).length).toBeLessThanOrEqual(max);
    expect(result.output).toContainEqual(
      expect.objectContaining({
        type: 'system',
        content:
          'Output limit reached (1048576 characters). The runner dropped the remaining output.',
      }),
    );
    expect(streamed).toEqual(result.output);
  }, 10_000);
});
