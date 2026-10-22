import { vi } from 'vitest';
import { JsRunner } from './js/js-runner.js';
import { CapabilityStore } from './capabilities/capability-store.js';

// initialize() rejects when the worker fails to start (factory throws,
// the worker's `error` event, or its init-error message), still records
// `initError`, and stays retryable.

/** A worker that only does what the test tells it to. */
class FakeWorker extends EventTarget {
  postMessage = vi.fn();
  terminate = vi.fn();
  ready(): void {
    this.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' } }));
  }
  initError(message: string): void {
    this.dispatchEvent(new MessageEvent('message', { data: { type: 'init-error', message } }));
  }
  /** What the browser fires when it refuses to load the worker script. */
  loadError(message = ''): void {
    this.dispatchEvent(new ErrorEvent('error', { message }));
  }
}

describe('worker load failure', () => {
  let workers: FakeWorker[];
  const factory = () => {
    const w = new FakeWorker();
    workers.push(w);
    return w as unknown as Worker;
  };

  beforeEach(() => {
    workers = [];
  });

  describe('JsRunner', () => {
    let runner: JsRunner;
    beforeEach(() => {
      runner = new JsRunner(new CapabilityStore(), { workerFactory: factory });
    });
    afterEach(() => runner.dispose());

    it('rejects on the worker error event, records initError, and terminates the worker', async () => {
      const booted = runner.initialize();
      workers[0].loadError();
      await expect(booted).rejects.toThrow('JS worker failed to load.');
      expect(runner.initError.get()).toBe('JS worker failed to load.');
      expect(runner.ready.get()).toBe(false);
      expect(workers[0].terminate).toHaveBeenCalled();
    });

    it('rejects with the worker error message when there is one', async () => {
      const booted = runner.initialize();
      workers[0].loadError('404 js-worker');
      await expect(booted).rejects.toThrow('404 js-worker');
    });

    it('rejects on an init-error message', async () => {
      const booted = runner.initialize();
      workers[0].initError('wasm refused');
      await expect(booted).rejects.toThrow('wasm refused');
      expect(runner.initError.get()).toBe('wasm refused');
    });

    it('rejects when the factory throws', async () => {
      const throwing = new JsRunner(new CapabilityStore(), {
        workerFactory: () => {
          throw new Error('blocked by CSP');
        },
      });
      await expect(throwing.initialize()).rejects.toThrow('blocked by CSP');
      expect(throwing.initError.get()).toBe('blocked by CSP');
      throwing.dispose();
    });

    it('is retryable: a later initialize() spawns a fresh worker', async () => {
      const first = runner.initialize();
      workers[0].loadError();
      await expect(first).rejects.toThrow();

      const second = runner.initialize();
      expect(workers).toHaveLength(2);
      workers[1].ready();
      await expect(second).resolves.toBeUndefined();
      expect(runner.ready.get()).toBe(true);
      expect(runner.initError.get()).toBeNull();
    });
  });
});
