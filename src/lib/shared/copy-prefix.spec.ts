import { describe, it, expect } from 'vitest';
import { copyPrefix } from './copy-prefix.js';

describe('copyPrefix', () => {
  it.each([
    ['should return a short string as it is', 'abc', 5, 'abc'],
    ['should return a string of exactly the limit as it is', 'abcde', 5, 'abcde'],
    ['should cut a long string to the limit', 'abcdefgh', 5, 'abcde'],
    ['should return an empty string for a limit of 0', 'abc', 0, ''],
    ['should count UTF-16 code units', 'a\u{1F600}b', 2, 'a\uD83D'],
  ])('%s', (_name, text, maxChars, expected) => {
    expect(copyPrefix(text, maxChars)).toBe(expected);
  });

  it('should return the same characters as slice for a very long string', () => {
    const text = 'xy'.repeat(5_000_000);
    const result = copyPrefix(text, 10_000);
    expect(result).toBe(text.slice(0, 10_000));
    expect(result).toHaveLength(10_000);
  });
});
