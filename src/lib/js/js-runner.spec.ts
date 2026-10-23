import { vi } from 'vitest';
import type { CodeRunner } from '../shared/code-runner.js';
import { createJsWorkerFactory } from '../../workers/index.js';
import { JsRunner } from './js-runner.js';
import { CapabilityStore } from '../capabilities/capability-store.js';
import { FetchCapability } from '../capabilities/fetch-capability.js';
import type { ProxyAuth } from '../proxy/proxy-auth.js';

const stubProxyAuth = {
  proxyBase: () => null,
  authHeader: () => null,
  setToken: vi.fn(),
  clearToken: vi.fn(),
  invalidate: vi.fn(),
  tokenInvalid: () => false,
} as unknown as ProxyAuth;
import { StorageCapability, MapStorageBackend } from '../capabilities/storage-capability.js';
import { DiskCapability, MapDiskBackend } from '../capabilities/disk-capability.js';
import { TimerCapability } from '../capabilities/timer-capability.js';
import type { SandboxCapability } from '../capabilities/capability.js';
import type { OutputEntry } from '../shared/sandbox-types.js';

describe('JsRunner', () => {
  let service: JsRunner;
  let registry: CapabilityStore;

  beforeAll(async () => {
    registry = new CapabilityStore();
    // jsdom has no Worker: opt in to the in-process host (A30).
    service = new JsRunner(registry, {
      workerFactory: createJsWorkerFactory({ allowInProcess: true }),
    });
    await service.initialize();

    registry.register(new FetchCapability(stubProxyAuth));
    registry.register(new StorageCapability(new MapStorageBackend()));
    registry.register(new DiskCapability(new MapDiskBackend()));
    registry.register(new TimerCapability());
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
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'result', content: '2' }),
      ])
    );
  });

  // Test 2: console.log("hello") produces log type entry
  it('should capture console.log output', async () => {
    const result = await service.execute('console.log("hello")');
    expect(result.success).toBe(true);
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'log', content: 'hello' }),
      ])
    );
  });

  // Test 3: console.warn("caution") produces warn type entry
  it('should capture console.warn output', async () => {
    const result = await service.execute('console.warn("caution")');
    expect(result.success).toBe(true);
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'warn', content: 'caution' }),
      ])
    );
  });

  // Test 4: console.error("fail") produces error type entry
  it('should capture console.error output', async () => {
    const result = await service.execute('console.error("fail")');
    expect(result.success).toBe(true);
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'error', content: 'fail' }),
      ])
    );
  });

  // Test 5: Multiple console calls produce entries in order
  it('should produce multiple entries in order', async () => {
    const result = await service.execute(
      'console.log("first"); console.warn("second"); console.error("third")'
    );
    expect(result.success).toBe(true);
    expect(result.output.length).toBeGreaterThanOrEqual(4);
    expect(result.output[1]).toEqual(
      expect.objectContaining({ type: 'log', content: 'first' })
    );
    expect(result.output[2]).toEqual(
      expect.objectContaining({ type: 'warn', content: 'second' })
    );
    expect(result.output[3]).toEqual(
      expect.objectContaining({ type: 'error', content: 'third' })
    );
  });

  // Test 6: console.log("a", 1, true) produces "a 1 true"
  it('should join multiple console.log arguments with spaces', async () => {
    const result = await service.execute('console.log("a", 1, true)');
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'log', content: 'a 1 true' }),
      ])
    );
  });

  // Test 7: console.log({x: 1}) produces JSON-formatted content
  it('should JSON-stringify object arguments', async () => {
    const result = await service.execute('console.log({x: 1})');
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'log',
          content: expect.stringContaining('"x": 1'),
        }),
      ])
    );
  });

  // Test 8: ReferenceError
  it('should return error for ReferenceError', async () => {
    const result = await service.execute('unknownVar');
    expect(result.success).toBe(false);
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          content: expect.stringContaining('ReferenceError'),
        }),
      ])
    );
  });

  // Test 9: TypeError
  it('should return error for TypeError', async () => {
    const result = await service.execute('null.foo');
    expect(result.success).toBe(false);
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          content: expect.stringContaining('TypeError'),
        }),
      ])
    );
  });

  // Test 10: SyntaxError
  it('should return error for SyntaxError', async () => {
    const result = await service.execute('if (');
    expect(result.success).toBe(false);
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          content: expect.stringContaining('SyntaxError'),
        }),
      ])
    );
  });

  // Test 11: Thrown primitive
  it('should handle thrown primitives', async () => {
    const result = await service.execute("throw 'oops'");
    expect(result.success).toBe(false);
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'error' }),
      ])
    );
  });

  // Test 12: Timeout
  it('should timeout on infinite loops', async () => {
    service.timeoutMs = 100;
    const result = await service.execute('while(true){}');
    service.timeoutMs = 5000;
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'system' }),
      ])
    );
  }, 10000);

  // Test 13: typeof window is undefined
  it('should not expose window', async () => {
    const result = await service.execute('typeof window');
    expect(result.success).toBe(true);
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'result', content: 'undefined' }),
      ])
    );
  });

  // Test 14: typeof document is undefined
  it('should not expose document', async () => {
    const result = await service.execute('typeof document');
    expect(result.success).toBe(true);
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'result', content: 'undefined' }),
      ])
    );
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
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'result',
          content: expect.stringContaining("fetch is not available"),
        }),
      ])
    );
  });

  // Test 16: typeof localStorage is undefined
  it('should not expose localStorage', async () => {
    const result = await service.execute('typeof localStorage');
    expect(result.success).toBe(true);
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'result', content: 'undefined' }),
      ])
    );
  });

  // Test 17: No state leakage between runs
  it('should not leak state between executions', async () => {
    await service.execute('var x = 42; x');
    const result = await service.execute('typeof x');
    expect(result.success).toBe(true);
    expect(result.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'result', content: 'undefined' }),
      ])
    );
  });

  // Test 19: running() transitions
  it('should set running to false after execution completes', async () => {
    expect(service.isRunning.get()).toBe(false);
    const result = await service.execute('1 + 1');
    expect(service.isRunning.get()).toBe(false);
    expect(result.success).toBe(true);
  });

  describe('Phase 3: Capabilities', () => {
    afterEach(() => {
      registry.setEnabled('fetch', false);
      registry.setEnabled('storage', false);
      registry.setEnabled('disk', false);
    });

    // Test 33: Enabled capability is available in sandbox
    it('should expose fetch as function when enabled', async () => {
      registry.setEnabled('fetch', true);
      const result = await service.execute('typeof fetch');
      expect(result.success).toBe(true);
      expect(result.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'result', content: 'function' }),
        ])
      );
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
      expect(result.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'result', content: 'val:hi' }),
        ])
      );
    });

    // Test 35: Config change between executions takes effect
    it('should apply config changes between executions', async () => {
      registry.setEnabled('storage', true);
      const r1 = await service.execute(`storage.setItem('k', 'v'); storage.getItem('k')`);
      expect(r1.success).toBe(true);
      expect(r1.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'result', content: 'v' }),
        ])
      );

      registry.setEnabled('storage', false);
      const r2 = await service.execute(`
        try { storage.getItem('k'); 'no error'; } catch(e) { e.message; }
      `);
      expect(r2.success).toBe(true);
      expect(r2.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'result',
            content: expect.stringContaining('storage.getItem() is not available'),
          }),
        ])
      );
    });

    // Test 36: Console works alongside capabilities (regression)
    it('should support console alongside capabilities', async () => {
      registry.setEnabled('fetch', true);
      const result = await service.execute('console.log("hello"); 42');
      expect(result.success).toBe(true);
      expect(result.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'log', content: 'hello' }),
          expect.objectContaining({ type: 'result', content: '42' }),
        ])
      );
    });

    // Test 37: Timeout works with asyncify (regression)
    it('should timeout with capabilities enabled', async () => {
      registry.setEnabled('fetch', true);
      service.timeoutMs = 100;
      const result = await service.execute('while(true){}');
      service.timeoutMs = 5000;
      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
    }, 10000);

    // Test 38: Custom capability without modifying JsRunner (extensibility).
    // Custom capabilities are host-backed: the worker injects a bridge
    // function per stubInfo entry and relays calls to invokeHost here.
    it('should support custom capabilities without modifying JsRunner', async () => {
      const customCap: SandboxCapability = {
        name: 'testGlobal',
        description: 'A test capability',
        stubInfo: { name: 'testGlobal', type: 'function' },
        async invokeHost() {
          return 'custom-works';
        },
      };
      registry.register(customCap);
      registry.setEnabled('testGlobal', true);

      const result = await service.execute('testGlobal()');
      expect(result.success).toBe(true);
      expect(result.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'result', content: 'custom-works' }),
        ])
      );

      registry.setEnabled('testGlobal', false);
    });

    // Test 39: System message shows enabled capabilities
    it('should emit system message with enabled capabilities', async () => {
      registry.setEnabled('fetch', true);
      registry.setEnabled('storage', true);
      const result = await service.execute('1');
      expect(result.output[0]).toEqual(
        expect.objectContaining({ type: 'system', content: '[fetch, storage enabled]' })
      );
    });

    // Test 40: System message shows no capabilities when none enabled
    it('should emit system message when no capabilities enabled', async () => {
      const result = await service.execute('1');
      expect(result.output[0]).toEqual(
        expect.objectContaining({ type: 'system', content: '[no capabilities enabled]' })
      );
    });
  });

  describe('Phase 4: Timer Capability', () => {
    afterEach(() => {
      registry.setEnabled('timer', false);
      service.timeoutMs = 5000;
    });

    // T5: setTimeout fires basic callback
    it('A23: should fire setTimeout callback and capture console output', async () => {
      registry.setEnabled('timer', true);
      const result = await service.execute(`setTimeout(() => console.log('fired'), 0)`);
      expect(result.success).toBe(true);
      expect(result.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'log', content: 'fired' }),
        ])
      );
    });

    // T6: Timer callback warn/error produce correct output types
    it('should capture warn/error output from timer callbacks', async () => {
      registry.setEnabled('timer', true);
      const result = await service.execute(`
        setTimeout(() => console.warn('w'), 0);
        setTimeout(() => console.error('e'), 0);
      `);
      expect(result.success).toBe(true);
      expect(result.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'warn', content: 'w' }),
          expect.objectContaining({ type: 'error', content: 'e' }),
        ])
      );
    });

    // T7: Three setTimeouts at delay 0 fire in registration order
    it('should fire setTimeouts in registration order at delay 0', async () => {
      registry.setEnabled('timer', true);
      const result = await service.execute(`
        setTimeout(() => console.log('a'), 0);
        setTimeout(() => console.log('b'), 0);
        setTimeout(() => console.log('c'), 0);
      `);
      expect(result.success).toBe(true);
      const logs = result.output.filter((e) => e.type === 'log').map((e) => e.content);
      expect(logs).toEqual(['a', 'b', 'c']);
    });

    // T8: setInterval + clearInterval after 3 fires
    it('A23: should fire setInterval until clearInterval is called', async () => {
      registry.setEnabled('timer', true);
      const result = await service.execute(`
        let count = 0;
        const id = setInterval(() => {
          count++;
          console.log('tick:' + count);
          if (count === 3) clearInterval(id);
        }, 10);
      `);
      expect(result.success).toBe(true);
      const logs = result.output.filter((e) => e.type === 'log').map((e) => e.content);
      expect(logs).toEqual(['tick:1', 'tick:2', 'tick:3']);
    });

    // T9: clearTimeout cancels a pending callback
    it('should cancel callback when clearTimeout is called before drain', async () => {
      registry.setEnabled('timer', true);
      const result = await service.execute(`
        const a = setTimeout(() => console.log('a'), 100);
        const b = setTimeout(() => console.log('b'), 100);
        clearTimeout(a);
      `);
      expect(result.success).toBe(true);
      const logs = result.output.filter((e) => e.type === 'log').map((e) => e.content);
      expect(logs).toEqual(['b']);
    });

    // T10: clearTimeout from inside another callback
    it('should allow clearTimeout from inside a timer callback', async () => {
      registry.setEnabled('timer', true);
      const result = await service.execute(`
        const b = setTimeout(() => console.log('b'), 200);
        setTimeout(() => {
          console.log('a');
          clearTimeout(b);
        }, 50);
      `);
      expect(result.success).toBe(true);
      const logs = result.output.filter((e) => e.type === 'log').map((e) => e.content);
      expect(logs).toEqual(['a']);
    });

    // T11: Nested setTimeout
    it('should fire nested setTimeout callbacks', async () => {
      registry.setEnabled('timer', true);
      const result = await service.execute(`
        setTimeout(() => {
          console.log('outer');
          setTimeout(() => console.log('inner'), 0);
        }, 0);
      `);
      expect(result.success).toBe(true);
      const logs = result.output.filter((e) => e.type === 'log').map((e) => e.content);
      expect(logs).toEqual(['outer', 'inner']);
    });

    // T12: Promise + setTimeout
    it('should resolve promises wrapping setTimeout', async () => {
      registry.setEnabled('timer', true);
      const result = await service.execute(`
        new Promise(r => setTimeout(r, 0)).then(() => console.log('p'));
      `);
      expect(result.success).toBe(true);
      expect(result.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'log', content: 'p' }),
        ])
      );
    });

    // T13: Promise chain interleaved with timer
    it('should interleave promise chain with timer callbacks', async () => {
      registry.setEnabled('timer', true);
      const result = await service.execute(`
        Promise.resolve()
          .then(() => console.log('m1'))
          .then(() => new Promise(r => setTimeout(r, 0)))
          .then(() => console.log('m2'));
      `);
      expect(result.success).toBe(true);
      const logs = result.output.filter((e) => e.type === 'log').map((e) => e.content);
      expect(logs).toEqual(['m1', 'm2']);
    });

    // T14: setTimeout fires via virtual time advancement (not real wait)
    it('should fire delayed setTimeout via virtual time without real-time wait', async () => {
      registry.setEnabled('timer', true);
      const t0 = Date.now();
      const result = await service.execute(`setTimeout(() => console.log('done'), 5000)`);
      const elapsed = Date.now() - t0;
      expect(result.success).toBe(true);
      expect(elapsed).toBeLessThan(500);
      const logs = result.output.filter((e) => e.type === 'log').map((e) => e.content);
      expect(logs).toEqual(['done']);
    });

    // T15: setInterval fires multiple times via virtual time
    it('should fire setInterval multiple times via virtual time', async () => {
      registry.setEnabled('timer', true);
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
      expect(elapsed).toBeLessThan(500);
      const logs = result.output.filter((e) => e.type === 'log').map((e) => e.content);
      expect(logs).toEqual(['n:1', 'n:2', 'n:3', 'n:4', 'n:5']);
    });

    // T20: Runaway interval with short timeout
    it('should time out a runaway setInterval', async () => {
      registry.setEnabled('timer', true);
      service.timeoutMs = 100;
      const result = await service.execute(`setInterval(() => {}, 1)`);
      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
    }, 10000);

    // T21: Timer-driven timeout emits same system message format
    it('should emit standard timeout system message on timer-driven timeout', async () => {
      registry.setEnabled('timer', true);
      service.timeoutMs = 100;
      const result = await service.execute(`setInterval(() => {}, 1)`);
      expect(result.timedOut).toBe(true);
      expect(result.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'system',
            content: 'Execution timed out: script exceeded the time limit.',
          }),
        ])
      );
    }, 10000);

    // T22: Disabled — all four globals throw
    it('A23: should throw descriptive errors for all four timer globals when disabled', async () => {
      const result = await service.execute(`
        const errs = [];
        for (const name of ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']) {
          try { globalThis[name](() => {}, 0); errs.push(name + ':no-error'); }
          catch (e) { errs.push(name + ':' + e.message); }
        }
        errs.join('|');
      `);
      expect(result.success).toBe(true);
      const lastResult = result.output.find((e) => e.type === 'result');
      expect(lastResult?.content).toContain(
        "setTimeout is not available: the 'timer' capability is not enabled."
      );
      expect(lastResult?.content).toContain(
        "setInterval is not available: the 'timer' capability is not enabled."
      );
      expect(lastResult?.content).toContain(
        "clearTimeout is not available: the 'timer' capability is not enabled."
      );
      expect(lastResult?.content).toContain(
        "clearInterval is not available: the 'timer' capability is not enabled."
      );
    });

    // T24: Invalid IDs to clearTimeout/clearInterval
    it('should no-op on clearTimeout/clearInterval with invalid IDs', async () => {
      registry.setEnabled('timer', true);
      const result = await service.execute(`
        clearTimeout(99999);
        clearInterval(99999);
        'ok';
      `);
      expect(result.success).toBe(true);
      expect(result.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'result', content: 'ok' }),
        ])
      );
    });

    // T25: State isolation across executions
    it('should not see timers from a previous execute() call', async () => {
      registry.setEnabled('timer', true);
      // First execution: register a timer that does not fire (cleared immediately)
      const r1 = await service.execute(`
        const id = setTimeout(() => console.log('first'), 0);
        clearTimeout(id);
        'r1';
      `);
      expect(r1.success).toBe(true);
      // Second execution: register a different timer
      const r2 = await service.execute(`setTimeout(() => console.log('second'), 0)`);
      expect(r2.success).toBe(true);
      const r2Logs = r2.output.filter((e) => e.type === 'log').map((e) => e.content);
      expect(r2Logs).toEqual(['second']);
      expect(r2Logs).not.toContain('first');
    });

    // T26: Timer IDs reset on new execute() call
    it('should reset timer IDs on each execute() call', async () => {
      registry.setEnabled('timer', true);
      const r1 = await service.execute(`setTimeout(() => {}, 100)`);
      const id1 = (r1.output.find((e) => e.type === 'result')?.content) ?? '';
      const r2 = await service.execute(`setTimeout(() => {}, 100)`);
      const id2 = (r2.output.find((e) => e.type === 'result')?.content) ?? '';
      // Both must be the same first ID (1). This shows a fresh state
      expect(id1).toBe(id2);
      expect(id1).toBe('1');
    });

    // T18: System message includes 'timer'
    it('should include timer in the system message when enabled', async () => {
      registry.setEnabled('timer', true);
      const result = await service.execute('1');
      expect(result.output[0]).toEqual(
        expect.objectContaining({
          type: 'system',
          content: expect.stringContaining('timer'),
        })
      );
    });

    // T19: Disabled then enabled then run
    it('should reflect timer config changes between executions', async () => {
      // Disabled: throws
      const r1 = await service.execute(`
        try { setTimeout(() => {}, 0); 'no-error'; } catch (e) { e.message; }
      `);
      expect(r1.success).toBe(true);
      expect(r1.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'result',
            content: expect.stringContaining('not available'),
          }),
        ])
      );

      // Enabled: succeeds
      registry.setEnabled('timer', true);
      const r2 = await service.execute(`setTimeout(() => console.log('ok'), 0)`);
      expect(r2.success).toBe(true);
      expect(r2.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'log', content: 'ok' }),
        ])
      );
    });

    // T29: 100 setTimeouts all fire
    it('should fire 100 setTimeouts at delay 0 without leaking', async () => {
      registry.setEnabled('timer', true);
      const result = await service.execute(`
        let count = 0;
        for (let i = 0; i < 100; i++) {
          setTimeout(() => count++, 0);
        }
        // Schedule a final timer to read the count after all others fire
        setTimeout(() => console.log('done:' + count), 1);
      `);
      expect(result.success).toBe(true);
      expect(result.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'log', content: 'done:100' }),
        ])
      );
    });
  });

  // CodeRunner conformance
  describe('CodeRunner conformance', () => {
    it('is assignable to CodeRunner without any casts', () => {
      const runner: CodeRunner = service;
      expect(typeof runner.ready.get).toBe('function');
      expect(typeof runner.isRunning.get).toBe('function');
      expect(typeof runner.initError.get).toBe('function');
      expect(typeof runner.initialize).toBe('function');
      expect(typeof runner.execute).toBe('function');
      expect(typeof runner.abort).toBe('function');
    });

    it('isRunning settles back to false after a run', async () => {
      expect(service.isRunning.get()).toBe(false);
      const p = service.execute('1 + 1');
      // execute sets running synchronously. The microtask queue can still
      // be empty when we read, so only await the promise.
      await p;
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

    it('abort() during execute() settles with success === false', async () => {
      service.timeoutMs = 1000;
      try {
        const p = service.execute('while (true) {}');
        // Give the asyncify pump one tick to start the WASM loop. Then
        // request abort.
        await new Promise((r) => setTimeout(r, 20));
        await service.abort();
        const result = await p;
        expect(result.success).toBe(false);
      } finally {
        service.timeoutMs = 5000;
      }
    }, 5000);
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

    afterEach(() => {
      registry.setEnabled('hang', false);
      service.timeoutMs = 5000;
    });

    it('abort() promptly ends a run suspended on a pending host call', async () => {
      registry.setEnabled('hang', true);
      const p = service.execute('hang()');
      // Let the run reach the never-resolving host call.
      await new Promise((r) => setTimeout(r, 50));
      expect(service.isRunning.get()).toBe(true);
      const t0 = Date.now();
      await service.abort();
      const result = await p;
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.error).toBe('Execution aborted.');
      expect(result.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'system', content: 'Execution aborted.' }),
        ]),
      );
      expect(service.isRunning.get()).toBe(false);
    }, 10000);

    it('preserves output emitted before the abort', async () => {
      registry.setEnabled('hang', true);
      const p = service.execute('console.log("partial"); hang()');
      await new Promise((r) => setTimeout(r, 50));
      await service.abort();
      const result = await p;
      expect(result.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'log', content: 'partial' }),
          expect.objectContaining({ type: 'system', content: 'Execution aborted.' }),
        ]),
      );
    }, 10000);

    it('execute() works again after abort() (worker respawned)', async () => {
      registry.setEnabled('hang', true);
      const p = service.execute('hang()');
      await new Promise((r) => setTimeout(r, 50));
      await service.abort();
      await p;
      registry.setEnabled('hang', false);
      const result = await service.execute('40 + 2');
      expect(result.success).toBe(true);
      expect(result.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'result', content: '42' }),
        ]),
      );
    }, 10000);

    it('backstop timeout ends a run stuck in a pending host call', async () => {
      registry.setEnabled('hang', true);
      service.timeoutMs = 100;
      const result = await service.execute('hang()');
      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'system',
            content: 'Execution timed out: script exceeded the time limit.',
          }),
        ]),
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

    afterEach(() => {
      registry.setEnabled('whoami', false);
    });

    it('a host capability sees the run tag; it is null after the run', async () => {
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
      const p = service.execute('console.log("one"); console.log("two"); 3');
      const result = await p;
      off();
      expect(streamed).toEqual(result.output);
      expect(streamed.map((e) => e.content)).toEqual(
        expect.arrayContaining(['one', 'two', '3']),
      );
    });
  });
});
