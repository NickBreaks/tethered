import { describe, it, expect } from 'vitest';
import { serialize } from './serialize.js';

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
});
