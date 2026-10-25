import { describe, it, expect } from 'vitest';
import { MAX_PRETTY_DEPTH, serialize } from './serialize.js';

function nested(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}

describe('serialize', () => {
  it.each([
    ['should return "null" for null', null, 'null'],
    ['should return "undefined" for undefined', undefined, 'undefined'],
    ['should pretty-print objects as JSON', { x: 1 }, '{\n  "x": 1\n}'],
    ['should pretty-print arrays as JSON', [1, 'a'], '[\n  1,\n  "a"\n]'],
    ['should return the string itself for string values', 'hello', 'hello'],
    ['should return the string itself for a string that looks like JSON', '{"x":1}', '{"x":1}'],
    ['should return string representation of numbers', 42, '42'],
    ['should return string representation of booleans', false, 'false'],
  ])('%s', (_name, value, expected) => {
    expect(serialize(value)).toBe(expected);
  });

  it('should return "[Object]" for circular objects', () => {
    const obj: Record<string, unknown> = {};
    obj['self'] = obj;
    expect(serialize(obj)).toBe('[Object]');
  });

  it('should return "[Object]" for objects that JSON.stringify cannot convert', () => {
    expect(serialize({ n: 1n })).toBe('[Object]');
  });

  it('should pretty-print a value at the maximum depth', () => {
    const value = nested(MAX_PRETTY_DEPTH);
    expect(serialize(value)).toBe(JSON.stringify(value, null, 2));
  });

  it('should write compact JSON for a value deeper than the maximum depth', () => {
    const value = nested(MAX_PRETTY_DEPTH + 1);
    expect(serialize(value)).toBe(JSON.stringify(value));
  });

  it('should keep the text of a deep value linear in its depth', () => {
    // Indented JSON for this value has approximately 2 * 1000^2 characters.
    // Do not increase the depth: at depth 5000, JSON.stringify overflows
    // the stack on Node 22 and Node 24.
    const out = serialize(nested(1000));
    expect(out).toHaveLength(2 * 1000 + 1);
  });

  it('should not count brackets inside strings as depth', () => {
    const value = { s: '['.repeat(100) + '{'.repeat(100), q: 'a\\"[[[' };
    expect(serialize(value)).toBe(JSON.stringify(value, null, 2));
  });
});
