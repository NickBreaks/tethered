import { JsWorkerHost } from './workers/worker-host.js';
import type { JsMainToWorkerMsg, JsWorkerToMainMsg } from './index.js';

/**
 * The dedicated-worker globals this module touches. Declared locally rather
 * than via `/// <reference lib="webworker" />`, which conflicts with the
 * DOM lib the rest of the package compiles against (and whose
 * `MessageEvent` type this reuses).
 */
interface WorkerScope {
  postMessage(message: JsWorkerToMainMsg): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<JsMainToWorkerMsg>) => void,
  ): void;
}
const workerScope = globalThis as unknown as WorkerScope;

const host = new JsWorkerHost((msg) => workerScope.postMessage(msg));
workerScope.addEventListener('message', (e) => host.handleMessage(e.data));
void host.init();
