import { vi } from 'vitest';
import { createValue, derived } from './readable-value.js';

describe('createValue', () => {
  it('get() returns the initial value and then the latest set', () => {
    const v = createValue(1);
    expect(v.get()).toBe(1);
    v.set(2);
    expect(v.get()).toBe(2);
    v.update((n) => n + 1);
    expect(v.get()).toBe(3);
  });

  it('subscribe() does not fire immediately', () => {
    const v = createValue('a');
    const fn = vi.fn();
    v.subscribe(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('notifies synchronously with the new value', () => {
    const v = createValue(0);
    const seen: number[] = [];
    v.subscribe((n) => seen.push(n));
    v.set(1);
    expect(seen).toEqual([1]);
    v.set(2);
    expect(seen).toEqual([1, 2]);
  });

  it.each([
    ['the same object', { x: 1 }, (o: unknown) => o, false],
    ['an equal object with a new identity', { x: 1 }, () => ({ x: 1 }), true],
    ['NaN after NaN', Number.NaN, () => Number.NaN, false],
    ['-0 after 0', 0, () => -0, true],
  ])('notifies only on actual change (Object.is): %s', (_name, initial, next, notifies) => {
    const v = createValue<unknown>(initial);
    const fn = vi.fn();
    v.subscribe(fn);
    v.set(next(initial));
    expect(fn).toHaveBeenCalledTimes(notifies ? 1 : 0);
  });

  it('the returned function unsubscribes', () => {
    const v = createValue(0);
    const fn = vi.fn();
    const unsubscribe = v.subscribe(fn);
    unsubscribe();
    v.set(1);
    expect(fn).not.toHaveBeenCalled();
  });

  it('the same function subscribed twice gets two independent subscriptions', () => {
    const v = createValue(0);
    const fn = vi.fn();
    const off1 = v.subscribe(fn);
    v.subscribe(fn);
    v.set(1);
    expect(fn).toHaveBeenCalledTimes(2);
    off1();
    v.set(2);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('a subscriber that unsubscribes another mid-notification prevents its call', () => {
    const v = createValue(0);
    const second = vi.fn();
    let offSecond = () => {};
    v.subscribe(() => offSecond());
    offSecond = v.subscribe(second);
    v.set(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('a subscriber added mid-notification gets only the later changes', () => {
    const v = createValue(0);
    const late = vi.fn();
    let added = false;
    v.subscribe(() => {
      if (added) return;
      added = true;
      v.subscribe(late);
    });
    v.set(1);
    expect(late).not.toHaveBeenCalled();
    v.set(2);
    expect(late).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('a throwing subscriber does not starve the others', async () => {
    const v = createValue(0);
    const after = vi.fn();
    const errors: unknown[] = [];
    const queue = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((cb) => {
      try {
        cb();
      } catch (e) {
        errors.push(e);
      }
    });
    try {
      v.subscribe(() => {
        throw new Error('boom');
      });
      v.subscribe(after);
      v.set(1);
    } finally {
      queue.mockRestore();
    }
    expect(after).toHaveBeenCalledWith(1);
    expect(errors).toEqual([new Error('boom')]);
  });

  it('asReadonly() exposes only get/subscribe over the same state', () => {
    const v = createValue(0);
    const ro = v.asReadonly();
    expect(Object.keys(ro).sort()).toEqual(['get', 'subscribe']);
    const fn = vi.fn();
    ro.subscribe(fn);
    v.set(5);
    expect(ro.get()).toBe(5);
    expect(fn).toHaveBeenCalledWith(5);
  });

  it('clear() drops every subscriber', () => {
    const v = createValue(0);
    const fn = vi.fn();
    v.subscribe(fn);
    v.clear();
    v.set(1);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('derived', () => {
  it('computes from its sources and recomputes on change', () => {
    const a = createValue(1);
    const b = createValue(2);
    const sum = derived([a, b], () => a.get() + b.get());
    expect(sum.get()).toBe(3);
    a.set(10);
    expect(sum.get()).toBe(12);
    b.set(20);
    expect(sum.get()).toBe(30);
  });

  it('notifies only when the computed result changes', () => {
    const n = createValue(1);
    const isOdd = derived([n], () => n.get() % 2 === 1);
    const fn = vi.fn();
    isOdd.subscribe(fn);
    n.set(3);
    expect(fn).not.toHaveBeenCalled();
    n.set(4);
    expect(fn).toHaveBeenCalledWith(false);
  });

  it('dispose() detaches from the sources', () => {
    const n = createValue(1);
    const doubled = derived([n], () => n.get() * 2);
    const fn = vi.fn();
    doubled.subscribe(fn);
    doubled.dispose();
    n.set(2);
    expect(fn).not.toHaveBeenCalled();
    // A derived value that is detached does not compute again.
    expect(doubled.get()).toBe(2);
  });
});
