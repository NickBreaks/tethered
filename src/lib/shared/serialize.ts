/**
 * Above this nesting depth, `serialize` writes compact JSON. Indented JSON
 * grows with the square of the depth, so a deep value can make a very
 * long text. Compact JSON grows only with the size of the value.
 */
export const MAX_PRETTY_DEPTH = 20;

export function serialize(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    try {
      const compact = JSON.stringify(value);
      // `undefined` comes from a `toJSON` that returns undefined.
      if (compact === undefined || jsonDepth(compact) > MAX_PRETTY_DEPTH) return compact;
      return JSON.stringify(value, null, 2);
    } catch {
      return '[Object]';
    }
  }
  return String(value);
}

/** The maximum nesting depth of arrays and objects in a JSON text. */
function jsonDepth(json: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (inString) {
      if (c === 0x5c)
        i++; // A backslash escapes the next character.
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x5b || c === 0x7b) {
      depth++;
      if (depth > max) max = depth;
    } else if (c === 0x5d || c === 0x7d) {
      depth--;
    }
  }
  return max;
}
