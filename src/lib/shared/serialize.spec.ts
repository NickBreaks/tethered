import { describe, it, expect } from 'vitest';
import { serialize } from './serialize.js';

describe('serialize', () => {
  it('should return "null" for null', () => {
    expect(serialize(null)).toBe('null');
  });

  it('should return "undefined" for undefined', () => {
    expect(serialize(undefined)).toBe('undefined');
  });

  it('should pretty-print objects as JSON', () => {
    expect(serialize({ x: 1 })).toBe('{\n  "x": 1\n}');
  });

  it('should return the string itself for string values', () => {
    expect(serialize('hello')).toBe('hello');
  });

  it('should return string representation of numbers', () => {
    expect(serialize(42)).toBe('42');
  });

  it('should return "[Object]" for circular objects', () => {
    const obj: Record<string, unknown> = {};
    obj['self'] = obj;
    expect(serialize(obj)).toBe('[Object]');
  });
});
