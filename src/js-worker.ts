import { JsWorkerHost } from './workers/worker-host.js';
import type { JsMainToWorkerMsg, JsWorkerToMainMsg } from './lib/js/worker-protocol.js';

/**
 * The dedicated-worker globals that this module uses. They are declared
 * locally, not through `/// <reference lib="webworker" />`. That reference
 * conflicts with the DOM lib that the rest of the package compiles
 * against. This module reuses the `MessageEvent` type of the DOM lib.
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
