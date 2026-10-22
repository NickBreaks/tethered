// Default worker factory for tethered. Kept out of the core entry so
// consumers that pass their own factory don't bundle the engine worker
// (or, without `Worker`, the in-process engine host) a second time.
// Framework-free, like the core.

export { createJsWorkerFactory, defaultJsWorkerFactory } from './default-worker-factories.js';
export type { JsWorkerFactoryOptions } from './default-worker-factories.js';
export { InProcessJsWorker } from './in-process-worker.js';
