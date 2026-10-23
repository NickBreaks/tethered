import type {
  QuickJSAsyncContext,
  QuickJSAsyncRuntime,
  QuickJSHandle,
} from 'quickjs-emscripten-core';
import { serialize, type OutputEntry } from '../index.js';

export interface DrainResult {
  timedOut: boolean;
  hadError?: boolean;
}

interface TimerEntry {
  id: number;
  callback: QuickJSHandle;
  dueTime: number;
  interval: number | null;
  cleared: boolean;
}

/**
 * Guest `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval`
 * and the virtual-time event loop that runs them after the script's
 * top-level eval. Worker-internal. The public `TimerCapability` only
 * registers and toggles the globals. When it is enabled for a run, the
 * host installs one of these into the run's VM. After the run, the host
 * cleans it up.
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

  async drainEventLoop(
    runtime: QuickJSAsyncRuntime,
    vm: QuickJSAsyncContext,
    emit: (entry: OutputEntry) => void,
    deadlineMs: number,
  ): Promise<DrainResult> {
    this.virtualNow = Date.now();
    let hadError = false;
    let callbacksSinceYield = 0;
    let lastYieldWall = Date.now();

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

    const flushMicrotasks = (): boolean => {
      // Returns true if an error occurred (the caller must stop).
      const jobResult = runtime.executePendingJobs();
      const errHandle = jobResult.error;
      if (errHandle) {
        dumpError(errHandle);
        errHandle.dispose();
        jobResult.dispose();
        hadError = true;
        return true;
      }
      jobResult.dispose();
      return false;
    };

    while (true) {
      // 1. Wall-clock deadline check
      if (Date.now() >= deadlineMs) {
        return { timedOut: true, hadError };
      }

      // 2. Flush microtasks
      if (flushMicrotasks()) {
        return { timedOut: false, hadError };
      }

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
        // Find next due time among non-cleared entries
        let next: number | null = null;
        for (const e of this.timers.values()) {
          if (e.cleared) continue;
          if (next === null || e.dueTime < next) next = e.dueTime;
        }
        if (next === null) {
          // No timers remain. Check pending jobs one more time, then exit
          if (!runtime.hasPendingJob()) {
            return { timedOut: false, hadError };
          }
          // Pending jobs exist but no timers. The loop flushes them on the next iteration
          continue;
        }
        if (next > this.virtualNow) {
          this.virtualNow = next;
        }
        continue;
      }

      // 5. Fire due callbacks
      for (const entry of due) {
        // Check cleared again, because a previous callback can cancel it
        if (entry.cleared) continue;

        const callResult = vm.callFunction(entry.callback, vm.undefined);
        const callErr = callResult.error;
        if (callErr) {
          dumpError(callErr);
          if (callErr.alive) callErr.dispose();
          hadError = true;
        } else {
          const callVal = callResult.value as QuickJSHandle;
          if (callVal && callVal.alive) callVal.dispose();
        }

        if (entry.interval === null) {
          // One-shot: dispose handle, remove from registry
          if (entry.callback.alive) entry.callback.dispose();
          this.timers.delete(entry.id);
        } else {
          // Interval: reschedule
          entry.dueTime += entry.interval;
        }

        callbacksSinceYield++;

        // Periodic yield to host event loop
        const wallNow = Date.now();
        if (callbacksSinceYield >= 100 || wallNow - lastYieldWall >= 50) {
          await new Promise((r) => setTimeout(r, 0));
          callbacksSinceYield = 0;
          lastYieldWall = Date.now();
          if (Date.now() >= deadlineMs) {
            return { timedOut: true, hadError };
          }
        }
      }

      // 6. Flush microtasks created by callbacks
      if (flushMicrotasks()) {
        return { timedOut: false, hadError };
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
