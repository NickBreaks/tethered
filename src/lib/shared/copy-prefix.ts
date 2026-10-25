/**
 * Returns the first `maxChars` UTF-16 code units of `text`, as a new
 * string. When `text` is not longer than `maxChars`, it returns `text`.
 *
 * A plain `slice` is not sufficient to free memory. V8 can make a slice
 * that points into the parent string, and that slice keeps the full
 * parent in the heap. The `split`/`join` makes a flat copy that does not
 * refer to the parent. Thus a short result of a very long guest string
 * does not keep the long string in host memory.
 */
export function copyPrefix(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).split('').join('');
}
