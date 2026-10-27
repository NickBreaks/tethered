import { createEmitter } from './emitter.js';

describe('createEmitter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls every subscriber synchronously, in subscription order', () => {
    const e = createEmitter<number>();
    const seen: string[] = [];
    e.subscribe((n) => seen.push(`a${n}`));
    e.subscribe((n) => seen.push(`b${n}`));
    e.emit(1);
    seen.push('after');
    expect(seen).toEqual(['a1', 'b1', 'after']);
  });

  it('stops calls to a subscriber after its unsubscribe function runs', () => {
    const e = createEmitter<number>();
    const seen: number[] = [];
    const off = e.subscribe((n) => seen.push(n));
    e.emit(1);
    off();
    off();
    e.emit(2);
    expect(seen).toEqual([1]);
  });

  it('keeps two subscriptions of the same function apart', () => {
    const e = createEmitter<number>();
    const seen: number[] = [];
    const fn = (n: number): void => {
      seen.push(n);
    };
    const offFirst = e.subscribe(fn);
    e.subscribe(fn);
    e.emit(1);
    offFirst();
    e.emit(2);
    expect(seen).toEqual([1, 1, 2]);
  });

  it('does not call a subscriber that an earlier subscriber removed during the emit', () => {
    const e = createEmitter<number>();
    const seen: string[] = [];
    e.subscribe(() => {
      seen.push('a');
      offB();
    });
    const offB = e.subscribe(() => seen.push('b'));
    e.emit(1);
    expect(seen).toEqual(['a']);
  });

  it('does not call a subscriber that was added during the emit until the next emit', () => {
    const e = createEmitter<number>();
    const seen: string[] = [];
    e.subscribe((n) => {
      seen.push(`a${n}`);
      if (n === 1) e.subscribe((m) => seen.push(`late${m}`));
    });
    e.emit(1);
    expect(seen).toEqual(['a1']);
    e.emit(2);
    expect(seen).toEqual(['a1', 'a2', 'late2']);
  });

  it('calls the other subscribers when one throws, and throws its error again in a microtask', () => {
    const queued: (() => void)[] = [];
    vi.stubGlobal('queueMicrotask', (fn: () => void) => queued.push(fn));
    const e = createEmitter<number>();
    const seen: string[] = [];
    const boom = new Error('boom');
    e.subscribe(() => seen.push('a'));
    e.subscribe(() => {
      throw boom;
    });
    e.subscribe(() => seen.push('c'));
    expect(() => e.emit(1)).not.toThrow();
    expect(seen).toEqual(['a', 'c']);
    expect(queued).toHaveLength(1);
    expect(() => queued[0]!()).toThrow(boom);
  });

  it('clear() removes every subscriber', () => {
    const e = createEmitter<number>();
    const seen: number[] = [];
    e.subscribe((n) => seen.push(n));
    e.subscribe((n) => seen.push(n));
    e.clear();
    e.emit(1);
    expect(seen).toEqual([]);
  });
});
