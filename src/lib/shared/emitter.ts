/**
 * Zero-dependency event stream. It is the stateless sibling of
 * ReadableValue: it is for events (an output entry, the start of a run),
 * not for values. `subscribe(fn)` returns an unsubscribe function.
 * `emit()` calls every subscriber synchronously, in subscription order.
 */
interface Emitter<T> {
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
      // Make a snapshot, so that a subscribe or unsubscribe during
      // notification is safe. A subscriber that throws must not stop the
      // others. Its error is thrown again asynchronously.
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
