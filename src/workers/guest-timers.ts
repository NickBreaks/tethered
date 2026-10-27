import type {
  QuickJSAsyncContext,
  QuickJSAsyncRuntime,
  QuickJSHandle,
} from 'quickjs-emscripten-core';
import { serialize } from '../lib/shared/serialize.js';
import type { OutputEntry } from '../lib/shared/sandbox-types.js';
import { callFunctionAsync, executePendingJobsAsync, type SuspendGate } from './engine-async.js';

interface DrainResult {
  timedOut: boolean;
  hadError: boolean;
}

/**
 * The maximum number of promise jobs in one engine call. Between two
 * batches, the loop examines the deadline. Thus a promise chain that
 * never ends cannot keep the loop busy after the time limit.
 */
const JOB_BATCH = 1000;

/**
 * The maximum number of pending timers of one run. A timer is pending from
 * its `setTimeout` / `setInterval` call until it fires (one-shot) or the
 * guest clears it. The timer entries are host memory of the worker, outside
 * the memory limit of the engine. Thus this limit keeps them small.
 */
const MAX_PENDING_TIMERS = 10_000;

interface TimerEntry {
  id: number;
  callback: QuickJSHandle;
  dueTime: number;
  interval: number | null;
  cleared: boolean;
}

/**
 * Guest `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval`
 * and the event loop that runs promise jobs and timers after the
 * top-level eval of the script. Worker-internal. The public
 * `TimerCapability` only registers and toggles the globals.
 *
 * The host uses one of these objects for each run. It calls `install()`
 * only when the `timer` capability is enabled. It always calls
 * `drainEventLoop()`, because promise jobs must run also without timers.
 * After the run, the host cleans it up.
 *
 * The timers use virtual time. The clock starts at 0 when the run starts.
 * It moves only forward, to the due time of the next timer. Thus a timer
 * fires after all timers with an earlier due time, but no real time
 * passes.
 */
export class GuestTimers {
  private timers = new Map<number, TimerEntry>();
  private nextId = 1;
  private virtualNow = 0;
  /**
   * The timer whose callback runs now, else null. A clear does not dispose
   * the callback handle of this timer, because the engine uses it. The
   * drain loop disposes it after the callback.
   */
  private running: TimerEntry | null = null;

  install(vm: QuickJSAsyncContext): void {
    // Reset state on every install
    this.timers.clear();
    this.nextId = 1;
    this.virtualNow = 0;
    this.running = null;

    const makeError = (name: 'TypeError' | 'RangeError', msg: string): QuickJSHandle => {
      const evalResult = vm.evalCode(`(msg => new ${name}(msg))(${JSON.stringify(msg)})`);
      if (evalResult.error) {
        // This is not expected. Fall back to a generic error
        evalResult.error.dispose();
        return vm.newError(msg);
      }
      return evalResult.value as QuickJSHandle;
    };

    const register = (fnName: 'setTimeout' | 'setInterval', isInterval: boolean): void => {
      const fn = vm.newFunction(fnName, (cbHandle?: QuickJSHandle, delayHandle?: QuickJSHandle) => {
        if (!cbHandle || vm.typeof(cbHandle) !== 'function') {
          return {
            error: makeError('TypeError', `${fnName}: callback must be a function`),
          };
        }
        if (this.timers.size >= MAX_PENDING_TIMERS) {
          return {
            error: makeError(
              'RangeError',
              `${fnName}: too many pending timers (the limit is ${MAX_PENDING_TIMERS})`,
            ),
          };
        }
        let delay = 0;
        if (delayHandle && vm.typeof(delayHandle) === 'number') {
          const n = vm.getNumber(delayHandle);
          if (Number.isFinite(n) && n > 0) delay = n;
        }
        const id = this.nextId++;
        const dupHandle = cbHandle.dup();
        const dueTime = this.virtualNow + delay;
        this.timers.set(id, {
          id,
          callback: dupHandle,
          dueTime,
          interval: isInterval ? delay : null,
          cleared: false,
        });
        return { value: vm.newNumber(id) };
      });
      // The guest global is a guest function that converts the delay as a
      // browser does: to a number, then to a 32-bit integer. Thus a string
      // or an object with `valueOf()` gives its number, a fraction is cut
      // off, and NaN or Infinity gives 0. The conversion is guest code
      // outside a host function, so a `valueOf()` can call the
      // capabilities as all guest code can.
      const wrap = vm.evalCode(
        `(raw) => ({ ${fnName}(callback, delay = 0) { return raw(callback, +delay | 0); } }).${fnName}`,
      );
      const factory = vm.unwrapResult(wrap);
      const wrapped = vm.unwrapResult(vm.callFunction(factory, vm.undefined, fn));
      vm.setProp(vm.global, fnName, wrapped);
      wrapped.dispose();
      factory.dispose();
      fn.dispose();
    };

    const registerClear = (fnName: 'clearTimeout' | 'clearInterval'): void => {
      const fn = vm.newFunction(fnName, (idHandle?: QuickJSHandle) => {
        if (!idHandle || vm.typeof(idHandle) !== 'number') {
          return { value: vm.undefined };
        }
        const id = vm.getNumber(idHandle);
        const entry = this.timers.get(id);
        if (entry) {
          // Remove the entry now, so that a loop of set and clear calls
          // cannot fill the map. The callback of the running timer stays
          // alive until the drain loop disposes it.
          entry.cleared = true;
          this.timers.delete(id);
          if (entry !== this.running && entry.callback.alive) entry.callback.dispose();
        }
        return { value: vm.undefined };
      });
      vm.setProp(vm.global, fnName, fn);
      fn.dispose();
    };

    register('setTimeout', false);
    register('setInterval', true);
    registerClear('clearTimeout');
    registerClear('clearInterval');
  }

  /**
   * Runs the promise jobs and the due timers until none remain. Stops when
   * the deadline passes or `interrupted()` is true. `interrupted()` tells
   * if the interrupt handler of the engine stopped guest code. Then an
   * engine error is a timeout, not a guest error.
   *
   * The jobs and the timer callbacks run through async engine calls
   * (engine-async.ts). Thus a host call in them can suspend the engine.
   * `gate` tells the host functions when they can suspend.
   */
  async drainEventLoop(
    runtime: QuickJSAsyncRuntime,
    vm: QuickJSAsyncContext,
    emit: (entry: OutputEntry) => void,
    deadlineMs: number,
    interrupted: () => boolean,
    gate: SuspendGate,
  ): Promise<DrainResult> {
    let hadError = false;
    let stepsSinceYield = 0;
    let lastYieldWall = Date.now();
    const outOfTime = (): boolean => interrupted() || Date.now() >= deadlineMs;

    const dumpError = (handle: QuickJSHandle): void => {
      const errObj = vm.dump(handle);
      let content: string;
      if (
        typeof errObj === 'object' &&
        errObj !== null &&
        'name' in errObj &&
        'message' in errObj
      ) {
        const err = errObj as { name: string; message: string; stack?: string };
        content = err.stack
          ? `${err.name}: ${err.message}\n${err.stack}`
          : `${err.name}: ${err.message}`;
      } else {
        content = `Error: ${serialize(errObj)}`;
      }
      emit({ type: 'error', content, timestamp: Date.now() });
    };

    /** Lets the host event loop run from time to time. Returns true when the time is out. */
    const maybeYield = async (): Promise<boolean> => {
      stepsSinceYield++;
      if (stepsSinceYield >= 100 || Date.now() - lastYieldWall >= 50) {
        await new Promise((r) => setTimeout(r, 0));
        stepsSinceYield = 0;
        lastYieldWall = Date.now();
      }
      return outOfTime();
    };

    /** Runs all pending promise jobs, in batches. */
    const flushMicrotasks = async (): Promise<'ok' | 'error' | 'timeout'> => {
      while (runtime.hasPendingJob()) {
        if (outOfTime()) return 'timeout';
        const jobResult = await gate.suspendable(() => executePendingJobsAsync(runtime, JOB_BATCH));
        const errHandle = jobResult.error;
        if (errHandle) {
          // When the time is out, the interrupt handler stopped the job.
          if (outOfTime()) {
            errHandle.dispose();
            return 'timeout';
          }
          dumpError(errHandle);
          errHandle.dispose();
          hadError = true;
          return 'error';
        }
        if (await maybeYield()) return 'timeout';
      }
      return 'ok';
    };

    while (true) {
      // 1. Wall-clock deadline check
      if (outOfTime()) {
        return { timedOut: true, hadError };
      }

      // 2. Flush microtasks
      const flushed = await flushMicrotasks();
      if (flushed === 'timeout') return { timedOut: true, hadError };
      if (flushed === 'error') return { timedOut: false, hadError };

      // 3. Collect due timers
      const due: TimerEntry[] = [];
      for (const e of this.timers.values()) {
        if (e.dueTime <= this.virtualNow) {
          due.push(e);
        }
      }
      due.sort((a, b) => a.dueTime - b.dueTime || a.id - b.id);

      // 4. If no timers are due, advance the virtual clock or exit
      if (due.length === 0) {
        // Find the next due time. A clear removes its entry from the map.
        let next: number | null = null;
        for (const e of this.timers.values()) {
          if (next === null || e.dueTime < next) next = e.dueTime;
        }
        if (next === null) {
          // No timers remain, and step 2 ran all promise jobs
          return { timedOut: false, hadError };
        }
        this.virtualNow = next;
        continue;
      }

      // 5. Fire due callbacks. Each callback is a macrotask. Thus the loop
      // runs the promise jobs of a callback before the next callback.
      for (const entry of due) {
        // A previous callback can clear this timer. The clear removed the
        // entry and disposed its callback handle.
        if (entry.cleared) continue;

        // A one-shot timer is not pending when it fires. Remove it before
        // the callback, so that it does not count against the limit.
        if (entry.interval === null) this.timers.delete(entry.id);

        this.running = entry;
        let callResult;
        try {
          callResult = await gate.suspendable(() =>
            callFunctionAsync(vm, entry.callback, vm.undefined),
          );
        } finally {
          this.running = null;
          if (entry.interval === null || entry.cleared) {
            // A one-shot timer, or an interval that the callback cleared
            if (entry.callback.alive) entry.callback.dispose();
          } else {
            // Interval: reschedule
            entry.dueTime += entry.interval;
          }
        }
        const callErr = callResult.error;
        if (callErr) {
          if (outOfTime()) {
            if (callErr.alive) callErr.dispose();
            return { timedOut: true, hadError };
          }
          dumpError(callErr);
          if (callErr.alive) callErr.dispose();
          hadError = true;
        } else {
          if (callResult.value.alive) callResult.value.dispose();
        }

        const afterCallback = await flushMicrotasks();
        if (afterCallback === 'timeout') return { timedOut: true, hadError };
        if (afterCallback === 'error') return { timedOut: false, hadError };

        if (await maybeYield()) {
          return { timedOut: true, hadError };
        }
      }
    }
  }

  cleanup(): void {
    for (const entry of this.timers.values()) {
      if (entry.callback.alive) {
        try {
          entry.callback.dispose();
        } catch {
          // Ignore. VM cleanup can dispose the handle first
        }
      }
    }
    this.timers.clear();
    this.nextId = 1;
    this.virtualNow = 0;
    this.running = null;
  }
}
