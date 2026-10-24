import { vi } from 'vitest';
import { CapabilityStore, JsRunner } from '../index.js';
import { createJsWorkerFactory, defaultJsWorkerFactory } from './default-worker-factories.js';
import { InProcessJsWorker } from './in-process-worker.js';

// The in-process fallback is outside the security claim (it shares the
// caller's thread), so the default factory only uses it on request.

describe('default JS worker factory', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('without a global Worker', () => {
    beforeEach(() => vi.stubGlobal('Worker', undefined));

    it.each([
      ['defaultJsWorkerFactory', defaultJsWorkerFactory],
      ['createJsWorkerFactory()', createJsWorkerFactory()],
      ['createJsWorkerFactory({ allowInProcess: false })', createJsWorkerFactory({ allowInProcess: false })],
    ])('%s fails initialize() naming allowInProcess and sets initError', async (_, factory) => {
      const runner = new JsRunner(new CapabilityStore(), { workerFactory: factory });
      try {
        await expect(runner.initialize()).rejects.toThrow(/allowInProcess/);
        expect(runner.initError.get()).toMatch(/allowInProcess/);
        expect(runner.ready.get()).toBe(false);
      } finally {
        runner.dispose();
      }
    });

    it('allowInProcess: true falls back to the in-process host', () => {
      const worker = createJsWorkerFactory({ allowInProcess: true })();
      try {
        expect(worker).toBeInstanceOf(InProcessJsWorker);
      } finally {
        worker.terminate();
      }
    });
  });

  describe('with a global Worker', () => {
    class StubWorker {
      constructor(
        readonly url: URL | string,
        readonly options?: WorkerOptions,
      ) {}
    }

    beforeEach(() => vi.stubGlobal('Worker', StubWorker));

    it.each([
      ['defaultJsWorkerFactory', defaultJsWorkerFactory],
      ['createJsWorkerFactory()', createJsWorkerFactory()],
      ['createJsWorkerFactory({ allowInProcess: true })', createJsWorkerFactory({ allowInProcess: true })],
    ])('%s spawns a real module Worker', (_, factory) => {
      const worker = factory() as unknown as StubWorker;
      expect(worker).toBeInstanceOf(StubWorker);
      // The URL points at the worker entry. Vite rewrites it to the
      // source file (js-worker.ts). The build keeps js-worker.js.
      expect(String(worker.url)).toMatch(/\/js-worker\.(js|ts)(\?|$)/);
      expect(worker.options).toEqual({ type: 'module' });
    });
  });
});
