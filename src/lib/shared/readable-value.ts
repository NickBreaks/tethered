/**
 * Zero-dependency reactive value — the core's only reactive primitive.
 *
 * Semantics (useSyncExternalStore-compatible):
 *  - `get()` returns the current value synchronously.
 *  - `subscribe(fn)` does NOT fire immediately; `fn` runs synchronously on
 *    every later change, and only when the value actually changes
 *    (`Object.is`). It returns an unsubscribe function.
 *
 * Framework adapters bridge it to their own primitive (a signal, a store,
 * a `useSyncExternalStore` hook).
 */
export interface ReadableValue<T> {
  get(): T;
  subscribe(fn: (value: T) => void): () => void;
}

/** Internal writable counterpart. Not exported from the package. */
export interface WritableValue<T> extends ReadableValue<T> {
  set(value: T): void;
  update(fn: (value: T) => T): void;
  asReadonly(): ReadableValue<T>;
  /** Drops every subscriber (used by `dispose()`). */
  clear(): void;
}

/** A derived value that can detach from its sources. */
export interface DerivedValue<T> extends ReadableValue<T> {
  /** Unsubscribes from the sources and drops every subscriber. */
  dispose(): void;
}

export function createValue<T>(initial: T): WritableValue<T> {
  let current = initial;
  // One wrapper object per subscribe() call, so subscribing the same
  // function twice yields two independent subscriptions.
  const subscribers = new Set<{ fn: (value: T) => void }>();

  const readonly: ReadableValue<T> = {
    get: () => current,
    subscribe: (fn) => {
      const sub = { fn };
      subscribers.add(sub);
      return () => {
        subscribers.delete(sub);
      };
    },
  };

  const set = (value: T): void => {
    if (Object.is(value, current)) return;
    current = value;
    // Snapshot so (un)subscribing during notification is safe. A throwing
    // subscriber must not starve the rest; its error is rethrown async.
    for (const sub of [...subscribers]) {
      if (!subscribers.has(sub)) continue;
      try {
        sub.fn(value);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  };

  return {
    ...readonly,
    set,
    update: (fn) => set(fn(current)),
    asReadonly: () => readonly,
    clear: () => subscribers.clear(),
  };
}

/**
 * A value computed from `sources`. It subscribes to the sources eagerly
 * and recomputes on any change, notifying only when the result changes.
 */
export function derived<T>(
  sources: readonly ReadableValue<unknown>[],
  compute: () => T,
): DerivedValue<T> {
  const value = createValue(compute());
  const unsubs = sources.map((s) => s.subscribe(() => value.set(compute())));
  return {
    get: value.get,
    subscribe: value.subscribe,
    dispose: () => {
      for (const unsub of unsubs) unsub();
      value.clear();
    },
  };
}
