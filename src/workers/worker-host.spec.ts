import { vi } from 'vitest';
import { QuickJSAsyncContext, QuickJSAsyncWASMModule } from 'quickjs-emscripten-core';
import { JsWorkerHost } from './worker-host.js';
import type {
  JsCapabilitySnapshot,
  JsWorkerToMainMsg,
} from '../lib/js/worker-protocol.js';
import type { OutputEntry } from '../lib/shared/sandbox-types.js';

// The engine host, driven directly: no runner, no worker. These specs
// examine the `done` message that the host posts. That message is the
// only place where the host can tell the runner about a timeout or a
// spent heap. The guest must not be able to forge either one.

type DoneMsg = Extract<JsWorkerToMainMsg, { type: 'done' }>;

interface RunReport {
  done: DoneMsg;
  output: OutputEntry[];
}

describe('JsWorkerHost', () => {
  let host: JsWorkerHost;
  let runSeq = 0;
  const outputs = new Map<number, OutputEntry[]>();
  const waiting = new Map<number, (done: DoneMsg) => void>();

  beforeAll(async () => {
    host = new JsWorkerHost((msg) => {
      if (msg.type === 'output') {
        outputs.get(msg.runId)?.push(msg.entry);
      } else if (msg.type === 'done') {
        waiting.get(msg.runId)?.(msg);
      }
    });
    await host.init();
  }, 30_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function run(
    code: string,
    options: { timeoutMs?: number; capabilities?: JsCapabilitySnapshot[] } = {},
  ): Promise<RunReport> {
    const runId = ++runSeq;
    const output: OutputEntry[] = [];
    outputs.set(runId, output);
    const done = new Promise<DoneMsg>((resolve) => waiting.set(runId, resolve));
    host.handleMessage({
      type: 'run',
      runId,
      code,
      timeoutMs: options.timeoutMs ?? 2000,
      capabilities: options.capabilities ?? [],
    });
    return { done: await done, output };
  }

  describe('exhausted flag', () => {
    it.each([
      ["throw new Error('out of memory')"],
      ["throw new InternalError('out of memory')"],
      ["throw { name: 'InternalError', message: 'out of memory' }"],
      ["throw new InternalError('stack overflow')"],
      ["throw \"capability 'x' setup failed: {}\""],
      ["Promise.reject(new InternalError('out of memory'))"],
    ])('a guest that runs %s does not set exhausted', async (code) => {
      const { done } = await run(code);
      expect(done.success).toBe(false);
      expect(done.timedOut).toBe(false);
      expect(done.exhausted).toBeUndefined();
    }, 10_000);

    it('is set when a capability setup fails before the guest code starts', async () => {
      const { done } = await run('1', {
        capabilities: [
          {
            name: 'broken',
            enabled: true,
            hostBacked: true,
            stub: { type: 'object', name: 'broken', methods: ['go'] },
            setupScript: 'throw 1',
          },
        ],
      });
      expect(done.success).toBe(false);
      expect(done.error).toContain("capability 'broken' setup failed");
      expect(done.exhausted).toBe(true);
    }, 10_000);

    it('is set when the engine runtime of the run cannot start', async () => {
      vi.spyOn(QuickJSAsyncWASMModule.prototype, 'newRuntime').mockImplementation(() => {
        throw new Error('out of memory');
      });
      const { done } = await run('1');
      expect(done.success).toBe(false);
      expect(done.exhausted).toBe(true);
    }, 10_000);

    it('is set after an out-of-memory error only when a fresh engine cannot start', async () => {
      const real = QuickJSAsyncWASMModule.prototype.newRuntime;
      let calls = 0;
      vi.spyOn(QuickJSAsyncWASMModule.prototype, 'newRuntime').mockImplementation(function (
        this: QuickJSAsyncWASMModule,
        ...args: Parameters<typeof real>
      ) {
        // The first call makes the runtime of the run. The second call is
        // the check for a spent heap.
        calls++;
        if (calls === 2) throw new Error('out of memory');
        return real.apply(this, args);
      });
      const { done } = await run("throw new InternalError('out of memory')");
      expect(calls).toBe(2);
      expect(done.success).toBe(false);
      expect(done.exhausted).toBe(true);
    }, 10_000);

    it('a host error after the guest code starts does not set it', async () => {
      vi.spyOn(QuickJSAsyncContext.prototype, 'getPromiseState').mockImplementation(() => {
        throw new Error('out of memory');
      });
      const { done } = await run('1');
      expect(done.success).toBe(false);
      expect(done.error).toBe('out of memory');
      expect(done.exhausted).toBeUndefined();
    }, 10_000);
  });

  describe('timedOut flag', () => {
    it.each([
      ["throw { name: 'InternalError', message: 'interrupted' }"],
      ["throw new InternalError('interrupted')"],
      ["Promise.reject({ name: 'InternalError', message: 'interrupted' })"],
    ])('a guest that runs %s does not time out', async (code) => {
      const { done, output } = await run(code);
      expect(done.success).toBe(false);
      expect(done.timedOut).toBe(false);
      expect(done.error).toMatch(/^InternalError: interrupted/);
      expect(output).not.toContainEqual(expect.objectContaining({ type: 'system' }));
    }, 10_000);

    it('is set when the interrupt handler stops a hot loop', async () => {
      const { done } = await run('while (true) {}', { timeoutMs: 100 });
      expect(done.timedOut).toBe(true);
      expect(done.error).toBe('Execution timed out: script exceeded the time limit.');
    }, 10_000);

    it('is set when the interrupt handler stops a promise job, with no guest error entry', async () => {
      const { done, output } = await run('Promise.resolve().then(() => { while (true) {} })', {
        timeoutMs: 100,
      });
      expect(done.timedOut).toBe(true);
      expect(output.filter((e) => e.type === 'error')).toEqual([]);
    }, 10_000);

    it('is set for a promise chain that never ends', async () => {
      const t0 = Date.now();
      const { done } = await run('function f() { Promise.resolve().then(f) } f()', {
        timeoutMs: 200,
      });
      expect(done.timedOut).toBe(true);
      expect(Date.now() - t0).toBeLessThan(3000);
    }, 10_000);
  });
});
