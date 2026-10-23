import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncContext,
  type QuickJSAsyncRuntime,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-asyncify';
import { serialize } from '../lib/shared/serialize.js';
import type { OutputEntry } from '../lib/shared/sandbox-types.js';
import type { CapabilityStubInfo } from '../lib/capabilities/capability.js';
import {
  TIMEOUT_MSG,
  type JsCapabilitySnapshot,
  type JsMainToWorkerMsg,
  type JsWorkerToMainMsg,
} from '../lib/js/worker-protocol.js';
import { injectCapabilityBridge } from './capability-bridge.js';
import { GuestTimers } from './guest-timers.js';
import { SuspendGate } from './engine-async.js';

/** The memory limit of the engine runtime of each run. */
const MEMORY_LIMIT = 256 * 1024 * 1024;

/**
 * Error text that can come from a spent heap. The guest can write the
 * same text, so this text alone never sets `exhausted`. It only selects
 * the runs for which the worker tries to start a fresh engine.
 */
const OUT_OF_MEMORY = /out of memory/i;

/** How a run ended. The worker posts it as the `done` message. */
interface RunOutcome {
  success: boolean;
  timedOut: boolean;
  error?: string;
  exhausted?: boolean;
}

/** The state of the value of the top-level eval, after the event loop ran. */
type SettledValue =
  | { kind: 'value'; value: unknown }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'pending' };

/**
 * QuickJS execution engine hosted inside the web worker. It has no DOM or
 * framework dependencies. Thus it can also run in-process
 * (InProcessJsWorker) where `Worker` is not available, for example in
 * jsdom test environments.
 *
 * Privileged capabilities (storage/disk/fetch) stay on the main thread.
 * The host injects one asyncified bridge function per stubInfo entry.
 * That function relays the call over the `cap-call`/`cap-result` message
 * pair. The VM suspends while the main thread services the request. The
 * guest timers are pure computation and run natively in the worker
 * (GuestTimers). The `timer` capability's snapshot enables them.
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
    const { runId } = msg;
    const emit = (entry: OutputEntry): void => {
      this.post({ type: 'output', runId, entry });
    };
    const outcome = await this.#execute(msg, emit);
    // The text of the error can come from the guest. Thus it only selects
    // the runs to examine. The worker reports a spent heap only when it
    // cannot start a fresh engine. The engine of the run is gone now.
    if (
      !outcome.success &&
      !outcome.timedOut &&
      !outcome.exhausted &&
      OUT_OF_MEMORY.test(outcome.error ?? '') &&
      !this.#engineCanStart()
    ) {
      outcome.exhausted = true;
    }
    this.post({
      type: 'done',
      runId,
      success: outcome.success,
      timedOut: outcome.timedOut,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(outcome.exhausted ? { exhausted: true } : {}),
    });
  }

  /** Runs the guest code in a fresh engine runtime, and disposes the runtime. */
  async #execute(
    msg: Extract<JsMainToWorkerMsg, { type: 'run' }>,
    emit: (entry: OutputEntry) => void,
  ): Promise<RunOutcome> {
    const { runId, code, timeoutMs, capabilities } = msg;

    if (!this.#module) {
      const errMsg = 'WASM module not initialized';
      emit({ type: 'system', content: errMsg, timestamp: Date.now() });
      return { success: false, timedOut: false, error: errMsg };
    }

    const startTime = Date.now();
    const deadline = startTime + timeoutMs;
    let runtime: QuickJSAsyncRuntime | undefined;
    let vm: QuickJSAsyncContext | undefined;
    const loop = new GuestTimers();
    // Tells the host functions when a host call can suspend the engine.
    const gate = new SuspendGate();
    // False until the guest code starts. Before that, only host code runs.
    // Thus a failure in that time is not a guest error: the engine cannot
    // start.
    let guestStarted = false;
    // Set only by the interrupt handler, when it stops the guest after the
    // deadline. A guest cannot set it with a thrown value.
    let interrupted = false;

    try {
      runtime = this.#module.newRuntime();
      runtime.setMemoryLimit(MEMORY_LIMIT);
      runtime.setInterruptHandler(() => {
        if (Date.now() <= deadline) return false;
        interrupted = true;
        return true;
      });

      vm = runtime.newContext();
      this.#injectConsole(vm, emit, gate);

      for (const snap of capabilities) {
        if (!snap.enabled) {
          this.#injectDisabledStub(vm, snap.stub);
        } else if (snap.name === 'timer') {
          loop.install(vm);
        } else if (snap.hostBacked) {
          this.#injectHostBridge(vm, runId, snap, gate, () => {
            // A host call after the deadline does not start. The run is
            // out of time, as if the interrupt handler stopped it.
            if (Date.now() <= deadline) return true;
            interrupted = true;
            return false;
          });
        }
        // Enabled but neither in-worker nor host-backed: nothing to inject.
      }

      guestStarted = true;
      const evalVm = vm;
      const result = await gate.suspendable(() => evalVm.evalCodeAsync(code));

      if ('error' in result && result.error) {
        if (interrupted) {
          result.error.dispose();
          return this.#timedOut(emit);
        }
        const errorObj = vm.dump(result.error);
        result.error.dispose();
        return { success: false, timedOut: false, error: this.#reportError(errorObj, emit) };
      }

      const valueHandle = result.value;
      try {
        // Run the promise jobs and, when the timer capability is enabled,
        // the timers. The jobs can register timers, and the timers can
        // queue jobs.
        const drained = await loop.drainEventLoop(
          runtime,
          vm,
          emit,
          deadline,
          () => interrupted,
          gate,
        );
        if (drained.timedOut || interrupted) return this.#timedOut(emit);

        const settled = this.#settle(vm, valueHandle);
        if (settled.kind === 'rejected') {
          return {
            success: false,
            timedOut: false,
            error: this.#reportError(settled.error, emit),
          };
        }
        if (settled.kind === 'value' && settled.value !== undefined) {
          emit({ type: 'result', content: serialize(settled.value), timestamp: Date.now() });
        }
        return { success: drained.hadError !== true, timedOut: false };
      } finally {
        if (valueHandle.alive) valueHandle.dispose();
      }
    } catch (e) {
      if (interrupted) return this.#timedOut(emit);
      const content = e instanceof Error ? e.message : String(e);
      emit({ type: 'error', content, timestamp: Date.now() });
      return { success: false, timedOut: false, error: content, exhausted: !guestStarted };
    } finally {
      try {
        loop.cleanup();
      } catch {
        // Best effort. Timer handles can already be gone.
      }
      try {
        vm?.dispose();
      } catch {
        // The async variant can throw during context cleanup
      }
      try {
        runtime?.removeInterruptHandler();
        runtime?.dispose();
      } catch {
        // The async variant can throw during runtime cleanup
      }
    }
  }

  #timedOut(emit: (entry: OutputEntry) => void): RunOutcome {
    emit({ type: 'system', content: TIMEOUT_MSG, timestamp: Date.now() });
    return { success: false, timedOut: true, error: TIMEOUT_MSG };
  }

  /**
   * Reads the value of the top-level eval. A promise gives its settled
   * value or its rejection. A promise that is still pending after the
   * event loop can never settle, so it gives no value.
   */
  #settle(vm: QuickJSAsyncContext, handle: QuickJSHandle): SettledValue {
    const state = vm.getPromiseState(handle);
    if (state.type === 'pending') return { kind: 'pending' };
    if (state.type === 'fulfilled' && state.notAPromise) {
      return { kind: 'value', value: vm.dump(handle) };
    }
    const inner = state.type === 'fulfilled' ? state.value : state.error;
    try {
      const value: unknown = vm.dump(inner);
      return state.type === 'fulfilled' ? { kind: 'value', value } : { kind: 'rejected', error: value };
    } finally {
      if (inner.alive) inner.dispose();
    }
  }

  /**
   * Starts a fresh engine runtime and context and disposes them. Returns
   * false when this fails, that is, the heap of the worker is spent.
   */
  #engineCanStart(): boolean {
    if (!this.#module) return false;
    let runtime: QuickJSAsyncRuntime | undefined;
    let vm: QuickJSAsyncContext | undefined;
    try {
      runtime = this.#module.newRuntime();
      runtime.setMemoryLimit(MEMORY_LIMIT);
      vm = runtime.newContext();
      const result = vm.evalCode('0');
      if (result.error) {
        result.error.dispose();
        return false;
      }
      result.value.dispose();
      return true;
    } catch {
      return false;
    } finally {
      try {
        vm?.dispose();
        runtime?.dispose();
      } catch {
        // Best effort.
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

  #injectHostBridge(
    vm: QuickJSAsyncContext,
    runId: number,
    snap: JsCapabilitySnapshot,
    gate: SuspendGate,
    inTime: () => boolean,
  ): void {
    injectCapabilityBridge(
      vm,
      { name: snap.name, stub: snap.stub, setupScript: snap.setupScript },
      (method, args) =>
        inTime()
          ? this.#rpc(runId, snap.name, method, args)
          : Promise.reject(new Error(TIMEOUT_MSG)),
      gate,
    );
  }

  #injectConsole(
    vm: QuickJSAsyncContext,
    emit: (entry: OutputEntry) => void,
    gate: SuspendGate,
  ): void {
    const consoleObj = vm.newObject();

    for (const method of ['log', 'warn', 'error'] as const) {
      const fn = vm.newFunction(method, (...args: QuickJSHandle[]) => {
        // vm.dump can call guest code (toJSON). The engine cannot suspend
        // in this synchronous function, thus the gate is closed.
        const parts = gate.hostOnly(() => args.map((arg) => serialize(vm.dump(arg))));
        emit({ type: method, content: parts.join(' '), timestamp: Date.now() });
      });
      vm.setProp(consoleObj, method, fn);
      fn.dispose();
    }

    const global = vm.global;
    vm.setProp(global, 'console', consoleObj);
    consoleObj.dispose();
  }

  /**
   * Emits a guest error as an `error` entry and returns its text. Only the
   * interrupt handler can mark a run as timed out. Thus a guest error with
   * the name and message of an interrupt is an ordinary error here.
   */
  #reportError(errorObj: unknown, emit: (entry: OutputEntry) => void): string {
    let content: string;
    if (
      typeof errorObj === 'object' &&
      errorObj !== null &&
      'name' in errorObj &&
      'message' in errorObj
    ) {
      const err = errorObj as { name: string; message: string; stack?: string };
      content = err.stack
        ? `${err.name}: ${err.message}\n${err.stack}`
        : `${err.name}: ${err.message}`;
    } else {
      content = `Error: ${String(errorObj)}`;
    }
    emit({ type: 'error', content, timestamp: Date.now() });
    return content;
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
