import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncContext,
  type QuickJSAsyncRuntime,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-asyncify';
import {
  serialize,
  type CapabilityStubInfo,
  type OutputEntry,
  type JsCapabilitySnapshot,
  type JsMainToWorkerMsg,
  type JsWorkerToMainMsg,
} from '../index.js';
import { injectCapabilityBridge } from './capability-bridge.js';
import { GuestTimers } from './guest-timers.js';

const TIMEOUT_MSG = 'Execution timed out: script exceeded the time limit.';

/**
 * QuickJS execution engine hosted inside the web worker. Holds no DOM or
 * framework dependencies so it can also run in-process (InProcessJsWorker) where
 * `Worker` is unavailable, e.g. jsdom test environments.
 *
 * Privileged capabilities (storage/disk/fetch) stay on the main thread;
 * the host injects one asyncified bridge function per stubInfo entry that
 * relays the call over the `cap-call`/`cap-result` message pair. The VM
 * suspends while the main thread services the request. The guest timers
 * are pure computation and run natively in-worker (GuestTimers), switched
 * on by the `timer` capability's snapshot.
 */
export class JsWorkerHost {
  #module: QuickJSAsyncWASMModule | null = null;
  #nextCallId = 1;
  readonly #pendingCalls = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  constructor(private readonly post: (msg: JsWorkerToMainMsg) => void) {}

  async init(): Promise<void> {
    try {
      this.#module = await newQuickJSAsyncWASMModuleFromVariant(variant);
      this.post({ type: 'ready' });
    } catch (e) {
      this.post({
        type: 'init-error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  handleMessage(msg: JsMainToWorkerMsg): void {
    if (msg.type === 'run') {
      void this.#run(msg);
    } else if (msg.type === 'cap-result') {
      const pending = this.#pendingCalls.get(msg.callId);
      if (!pending) return;
      this.#pendingCalls.delete(msg.callId);
      if (msg.ok) {
        pending.resolve(msg.value);
      } else {
        pending.reject(new Error(msg.error ?? 'capability call failed'));
      }
    }
  }

  async #run(msg: Extract<JsMainToWorkerMsg, { type: 'run' }>): Promise<void> {
    const { runId, code, timeoutMs, capabilities } = msg;
    const emit = (entry: OutputEntry): void => {
      this.post({ type: 'output', runId, entry });
    };
    const done = (success: boolean, timedOut: boolean, error?: string): void => {
      this.post({ type: 'done', runId, success, timedOut, ...(error !== undefined ? { error } : {}) });
    };

    if (!this.#module) {
      const errMsg = 'WASM module not initialized';
      emit({ type: 'system', content: errMsg, timestamp: Date.now() });
      done(false, false, errMsg);
      return;
    }

    const startTime = Date.now();
    let runtime: QuickJSAsyncRuntime | undefined;
    let vm: QuickJSAsyncContext | undefined;
    let timers: GuestTimers | undefined;

    try {
      runtime = this.#module.newRuntime();
      runtime.setMemoryLimit(256 * 1024 * 1024);
      const deadline = startTime + timeoutMs;
      runtime.setInterruptHandler(() => Date.now() > deadline);

      vm = runtime.newContext();
      this.#injectConsole(vm, emit);

      for (const snap of capabilities) {
        if (!snap.enabled) {
          this.#injectDisabledStub(vm, snap.stub);
        } else if (snap.name === 'timer') {
          timers = new GuestTimers();
          timers.install(vm);
        } else if (snap.hostBacked) {
          this.#injectHostBridge(vm, runId, snap);
        }
        // Enabled but neither in-worker nor host-backed: nothing to inject.
      }

      const result = await vm.evalCodeAsync(code);

      if ('value' in result) {
        // Dump and dispose the eval result up-front so its lifetime
        // doesn't outlive any subsequent timer-driven microtask drain.
        // Note: vm.dump() on a fulfilled Promise consumes the handle
        // internally, so we must check alive before disposing.
        const value = vm.dump(result.value);
        if (result.value.alive) {
          result.value.dispose();
        }

        // Drain the timer event loop when the cap is enabled — pending
        // microtasks queued by the eval may still register timers.
        let hadTimerError = false;
        if (timers) {
          const drainResult = await timers.drainEventLoop(runtime, vm, emit, deadline);
          if (drainResult.timedOut) {
            emit({ type: 'system', content: TIMEOUT_MSG, timestamp: Date.now() });
            done(false, true, TIMEOUT_MSG);
            return;
          }
          hadTimerError = drainResult.hadError === true;
        }

        if (value !== undefined) {
          emit({ type: 'result', content: serialize(value), timestamp: Date.now() });
        }
        done(!hadTimerError, false);
      } else {
        const errorObj = vm.dump(result.error);
        result.error.dispose();
        const { error, timedOut } = this.#categorizeError(errorObj, emit);
        done(false, timedOut, error);
      }
    } catch (e) {
      const content = e instanceof Error ? e.message : String(e);
      emit({ type: 'error', content, timestamp: Date.now() });
      done(false, false, content);
    } finally {
      try {
        timers?.cleanup();
      } catch {
        // Best effort — timer handles may already be gone.
      }
      try {
        vm?.dispose();
      } catch {
        // Async variant may throw during context cleanup
      }
      try {
        runtime?.removeInterruptHandler();
        runtime?.dispose();
      } catch {
        // Async variant may throw during runtime cleanup
      }
    }
  }

  #rpc(runId: number, capability: string, method: string, args: unknown[]): Promise<unknown> {
    const callId = this.#nextCallId++;
    return new Promise<unknown>((resolve, reject) => {
      this.#pendingCalls.set(callId, { resolve, reject });
      this.post({ type: 'cap-call', callId, runId, capability, method, args });
    });
  }

  #injectHostBridge(vm: QuickJSAsyncContext, runId: number, snap: JsCapabilitySnapshot): void {
    injectCapabilityBridge(
      vm,
      { name: snap.name, stub: snap.stub, setupScript: snap.setupScript },
      (method, args) => this.#rpc(runId, snap.name, method, args),
    );
  }

  #injectConsole(vm: QuickJSAsyncContext, emit: (entry: OutputEntry) => void): void {
    const consoleObj = vm.newObject();

    for (const method of ['log', 'warn', 'error'] as const) {
      const fn = vm.newFunction(method, (...args: QuickJSHandle[]) => {
        const parts = args.map((arg) => {
          const value = vm.dump(arg);
          return serialize(value);
        });
        emit({ type: method, content: parts.join(' '), timestamp: Date.now() });
      });
      vm.setProp(consoleObj, method, fn);
      fn.dispose();
    }

    const global = vm.global;
    vm.setProp(global, 'console', consoleObj);
    consoleObj.dispose();
  }

  #categorizeError(
    errorObj: unknown,
    emit: (entry: OutputEntry) => void,
  ): { error: string; timedOut: boolean } {
    if (
      typeof errorObj === 'object' &&
      errorObj !== null &&
      'name' in errorObj &&
      'message' in errorObj
    ) {
      const err = errorObj as { name: string; message: string; stack?: string };

      if (err.name === 'InternalError' && err.message === 'interrupted') {
        emit({ type: 'system', content: TIMEOUT_MSG, timestamp: Date.now() });
        return { error: TIMEOUT_MSG, timedOut: true };
      }

      const content = err.stack
        ? `${err.name}: ${err.message}\n${err.stack}`
        : `${err.name}: ${err.message}`;
      emit({ type: 'error', content, timestamp: Date.now() });
      return { error: content, timedOut: false };
    }

    const content = `Error: ${String(errorObj)}`;
    emit({ type: 'error', content, timestamp: Date.now() });
    return { error: content, timedOut: false };
  }

  #injectDisabledStub(vm: QuickJSAsyncContext, info: CapabilityStubInfo): void {
    if (info.type === 'function') {
      const names = info.globals ?? [info.name];
      for (const fnName of names) {
        const stub = vm.newFunction(fnName, () => {
          return {
            error: vm.newError(
              `${fnName} is not available: the '${info.name}' capability is not enabled.`,
            ),
          };
        });
        vm.setProp(vm.global, fnName, stub);
        stub.dispose();
      }
    } else if (info.type === 'object') {
      const obj = vm.newObject();
      for (const method of info.methods ?? []) {
        const fn = vm.newFunction(method, () => {
          return {
            error: vm.newError(
              `${info.name}.${method}() is not available: the '${info.name}' capability is not enabled.`,
            ),
          };
        });
        vm.setProp(obj, method, fn);
        fn.dispose();
      }
      vm.setProp(vm.global, info.name, obj);
      obj.dispose();
    }
  }
}
