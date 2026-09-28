/**
 * Free text as it goes into a log line: a JSON string, so its quotes stay
 * and a newline in it is written as `\n`. `JSON.stringify` leaves some
 * characters as they are that a log reader can still take for a line break
 * or a terminal for a command, so those are escaped the same way: DEL and
 * the C1 controls (U+0085 is a line break to some tools), the Unicode line
 * and paragraph separators, and the bidirectional controls that can reorder
 * what a line appears to say.
 */
export function quoteForLog(text: string): string {
  return JSON.stringify(text).replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
