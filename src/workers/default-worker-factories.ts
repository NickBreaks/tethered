import { InProcessJsWorker } from './in-process-worker.js';

export interface JsWorkerFactoryOptions {
  /**
   * Where `Worker` doesn't exist (jsdom/SSR test environments), host the
   * engine in-process with `InProcessJsWorker` instead of failing. Off by
   * default: the in-process host shares the caller's thread, so it gives
   * none of a real Worker's isolation and cannot stop a hot synchronous
   * loop. Ignored when `Worker` exists — a real Worker is always used.
   */
  allowInProcess?: boolean;
}

/**
 * Builds a JS worker factory that spawns the bundled worker script
 * (`tethered/js-worker`, `dist/js-worker.js`) as a module Worker. Without a global `Worker` it throws (so `initialize()` rejects
 * and `initError` is set) unless `allowInProcess` is `true`. Bundlers that
 * can't follow `new URL(..., import.meta.url)` inside a dependency (e.g.
 * Vite's dep pre-bundling) should pass their own factory built on the
 * `tethered/js-worker` export instead — and then needn't
 * import this entry at all.
 */
export function createJsWorkerFactory(options: JsWorkerFactoryOptions = {}): () => Worker {
  const allowInProcess = options.allowInProcess === true;
  return () => {
    if (typeof Worker !== 'undefined') {
      return new Worker(new URL('../js-worker.js', import.meta.url), { type: 'module' });
    }
    if (!allowInProcess) {
      throw new Error(
        'No global Worker in this environment. Pass createJsWorkerFactory({ allowInProcess: true }) ' +
          'to run the JS engine in-process (tests/SSR only: no isolation from the host thread).',
      );
    }
    return new InProcessJsWorker() as unknown as Worker;
  };
}

/** `createJsWorkerFactory()`: a real Worker, no in-process fallback. */
export const defaultJsWorkerFactory: () => Worker = createJsWorkerFactory();
