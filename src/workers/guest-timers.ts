import type {
  QuickJSAsyncContext,
  QuickJSAsyncRuntime,
  QuickJSHandle,
} from 'quickjs-emscripten-core';
import { serialize } from '../lib/shared/serialize.js';
import type { OutputEntry } from '../lib/shared/sandbox-types.js';
import { callFunctionAsync, executePendingJobsAsync, SuspendGate } from './engine-async.js';

export interface DrainResult {
  timedOut: boolean;
  hadError?: boolean;
}

/**
 * The maximum number of promise jobs in one engine call. Between two
 * batches, the loop examines the deadline. Thus a promise chain that
 * never ends cannot keep the loop busy after the time limit.
 */
const JOB_BATCH = 1000;

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

  install(vm: QuickJSAsyncContext): void {
    // Reset state on every install
    this.timers.clear();
    this.nextId = 1;
    this.virtualNow = 0;

    const makeTypeError = (msg: string): QuickJSHandle => {
      const evalResult = vm.evalCode(
        `(msg => new TypeError(msg))(${JSON.stringify(msg)})`,
      );
      if (evalResult.error) {
        // This is not expected. Fall back to a generic error
        evalResult.error.dispose();
        return vm.newError(msg);
      }
      return evalResult.value as QuickJSHandle;
    };

    const register = (
      fnName: 'setTimeout' | 'setInterval',
      isInterval: boolean,
    ): void => {
      const fn = vm.newFunction(
        fnName,
        (cbHandle?: QuickJSHandle, delayHandle?: QuickJSHandle) => {
          if (!cbHandle || vm.typeof(cbHandle) !== 'function') {
            return {
              error: makeTypeError(`${fnName}: callback must be a function`),
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
        },
      );
      vm.setProp(vm.global, fnName, fn);
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
          entry.cleared = true;
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

  hasPendingTimers(): boolean {
    for (const e of this.timers.values()) {
      if (!e.cleared) return true;
    }
    return false;
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
    interrupted: () => boolean = () => false,
    gate: SuspendGate = new SuspendGate(),
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
        const jobResult = await gate.suspendable(() =>
          executePendingJobsAsync(runtime, JOB_BATCH),
        );
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
        if (!e.cleared && e.dueTime <= this.virtualNow) {
          due.push(e);
        }
      }
      due.sort((a, b) => (a.dueTime - b.dueTime) || (a.id - b.id));

      // 4. If no timers are due, advance the virtual clock or exit
      if (due.length === 0) {
        // Find the next due time among the entries that are not cleared
        let next: number | null = null;
        for (const e of this.timers.values()) {
          if (e.cleared) continue;
          if (next === null || e.dueTime < next) next = e.dueTime;
        }
        if (next === null) {
          // No timers remain, and step 2 ran all promise jobs
          return { timedOut: false, hadError };
        }
        if (next > this.virtualNow) {
          this.virtualNow = next;
        }
        continue;
      }

      // 5. Fire due callbacks. Each callback is a macrotask. Thus the loop
      // runs the promise jobs of a callback before the next callback.
      for (const entry of due) {
        // Check cleared again, because a previous callback can cancel it
        if (entry.cleared) continue;

        const callResult = await gate.suspendable(() =>
          callFunctionAsync(vm, entry.callback, vm.undefined),
        );
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

        if (entry.interval === null) {
          // One-shot: dispose handle, remove from registry
          if (entry.callback.alive) entry.callback.dispose();
          this.timers.delete(entry.id);
        } else {
          // Interval: reschedule
          entry.dueTime += entry.interval;
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
  }
}
