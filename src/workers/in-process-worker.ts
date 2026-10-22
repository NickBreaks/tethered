import type { JsWorkerHost } from './worker-host.js';
import type { JsMainToWorkerMsg, JsWorkerToMainMsg } from '../index.js';

type MessageListener = (event: MessageEvent<JsWorkerToMainMsg>) => void;

/**
 * Worker-shaped shim that hosts the real JS engine on the calling
 * thread. `createJsWorkerFactory({ allowInProcess: true })` falls back
 * to this when `Worker` is unavailable (jsdom/SSR test environments), so
 * JsRunner keeps working there with identical protocol semantics. It
 * gives no isolation, so it is opt-in and outside the security claim.
 *
 * Limitations vs a real worker: terminate() only detaches the message
 * channel — it cannot preempt a hot synchronous loop (the in-worker
 * timeout still ends those), and execution shares the caller's thread.
 *
 * worker-host is imported dynamically so the engine (embedded
 * wasm) stays out of the main bundle for browser consumers, who only
 * ever load it inside the real worker chunk.
 */
export class InProcessJsWorker {
  #host: JsWorkerHost | null = null;
  #terminated = false;
  readonly #listeners = new Set<MessageListener>();
  #inbox: JsMainToWorkerMsg[] = [];

  constructor() {
    void import('./worker-host.js').then(({ JsWorkerHost }) => {
      if (this.#terminated) return;
      this.#host = new JsWorkerHost((msg) => this.#deliver(msg));
      const queued = this.#inbox;
      this.#inbox = [];
      void this.#host.init().then(() => {
        for (const msg of queued) this.#host?.handleMessage(msg);
      });
    });
  }

  postMessage(msg: JsMainToWorkerMsg): void {
    if (this.#terminated) return;
    if (!this.#host) {
      this.#inbox.push(msg);
      return;
    }
    const host = this.#host;
    // Deliver asynchronously to mimic a real worker's message queue and
    // avoid re-entrancy into the caller's stack.
    queueMicrotask(() => {
      if (!this.#terminated) host.handleMessage(msg);
    });
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'message' && typeof listener === 'function') {
      this.#listeners.add(listener as MessageListener);
    }
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'message' && typeof listener === 'function') {
      this.#listeners.delete(listener as MessageListener);
    }
  }

  terminate(): void {
    this.#terminated = true;
    this.#listeners.clear();
    this.#inbox = [];
  }

  #deliver(msg: JsWorkerToMainMsg): void {
    if (this.#terminated) return;
    queueMicrotask(() => {
      if (this.#terminated) return;
      const event = { data: msg } as MessageEvent<JsWorkerToMainMsg>;
      for (const listener of [...this.#listeners]) {
        listener(event);
      }
    });
  }
}
