// Default worker factory for tethered. It is not in the core entry, so
// consumers that pass their own factory do not bundle the engine worker a
// second time. Without `Worker`, they also do not bundle the in-process
// engine host a second time. Framework-free, like the core.

export { createJsWorkerFactory, defaultJsWorkerFactory } from './default-worker-factories.js';
export type { JsWorkerFactoryOptions } from './default-worker-factories.js';
export { InProcessJsWorker } from './in-process-worker.js';
