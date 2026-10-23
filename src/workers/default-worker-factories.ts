import { InProcessJsWorker } from './in-process-worker.js';

export interface JsWorkerFactoryOptions {
  /**
   * If `Worker` does not exist (jsdom/SSR test environments), host the
   * engine in-process with `InProcessJsWorker`, and do not fail. Off by
   * default. The in-process host shares the caller's thread. Thus it gives
   * none of the isolation of a real Worker, and it cannot stop a hot
   * synchronous loop. Ignored when `Worker` exists: then a real Worker is
   * always used.
   */
  allowInProcess?: boolean;
}

/**
 * Builds a JS worker factory that starts the bundled worker script
 * (`tethered/js-worker`, `dist/js-worker.js`) as a module Worker. Without
 * a global `Worker`, it throws, unless `allowInProcess` is `true`. Then
 * `initialize()` rejects and `initError` is set. Some bundlers cannot
 * follow `new URL(..., import.meta.url)` inside a dependency (for
 * example, Vite's dep pre-bundling). With these bundlers, pass your own
 * factory built on the `tethered/js-worker` export. Then you do not need
 * to import this entry.
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
