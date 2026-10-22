/**
 * Zero-dependency event stream — the stateless sibling of ReadableValue,
 * for things that happen (an output entry, a run starting) rather than
 * values that are. `subscribe(fn)` returns an unsubscribe function;
 * `emit()` calls every subscriber synchronously, in subscription order.
 */
export interface Emitter<T> {
  emit(event: T): void;
  subscribe(fn: (event: T) => void): () => void;
  /** Drops every subscriber (used by `dispose()`). */
  clear(): void;
}

export function createEmitter<T>(): Emitter<T> {
  // One wrapper object per subscribe() call, as in createValue().
  const subscribers = new Set<{ fn: (event: T) => void }>();
  return {
    emit: (event) => {
      // Snapshot so (un)subscribing during notification is safe. A throwing
      // subscriber must not starve the rest; its error is rethrown async.
      for (const sub of [...subscribers]) {
        if (!subscribers.has(sub)) continue;
        try {
          sub.fn(event);
        } catch (err) {
          queueMicrotask(() => {
            throw err;
          });
        }
      }
    },
    subscribe: (fn) => {
      const sub = { fn };
      subscribers.add(sub);
      return () => {
        subscribers.delete(sub);
      };
    },
    clear: () => subscribers.clear(),
  };
}
