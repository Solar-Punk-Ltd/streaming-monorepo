/**
 * The frame SRS puts around every line of its log, for a reader that holds
 * one kind of line to its whole shape: in JavaScript on the manager, and as a
 * POSIX extended regular expression for grep on another host.
 *
 *   [2026-09-22 17:33:50.386][INFO][1][4ek6chsn] <message>
 *
 * The last bracket is SRS's id for the connection the line is about.
 */

/** A colour or cursor sequence, which SRS writes around the lines it prints to a console. */
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** `[time][level][pid][connection] `, the prefix SRS puts before every message, with the connection captured. */
export const SRS_LINE_PREFIX = String.raw`\[[^\]]*\]\[[A-Za-z]+\]\[\d+\]\[([A-Za-z0-9]{1,64})\] `;

/** No more digits than a JavaScript number holds exactly. */
export const DIGITS = String.raw`\d{1,15}`;

/** The line as the patterns read it: colour codes and trailing white space taken off. */
export function srsLogText(line: string): string {
  return line.replace(ANSI_ESCAPE, '').trimEnd();
}

/**
 * A colour or cursor sequence in POSIX ERE. ERE has no escape for the escape
 * byte, so it is written into the pattern literally. A `.` in its place would
 * let any byte stand in for it.
 */
const HOST_ESCAPE = '(\u001b\\[[0-9;]*[A-Za-z])*';
const HOST_LINE_PREFIX = String.raw`\[[^]]*\]\[[A-Za-z]+\]\[[0-9]+\]\[[A-Za-z0-9]{1,64}\] `;

/** `DIGITS` in POSIX ERE. */
export const HOST_DIGITS = '[0-9]{1,15}';

/**
 * A whole line of SRS's log whose message has the given POSIX ERE shape,
 * anchored at both ends with colour codes allowed around it. A publisher
 * chooses its stream name and SRS quotes it into lines that carry a key or a
 * token, so a filter on another host has to hold the whole line to the shape
 * rather than look for a marker in it.
 */
export function wholeHostLine(messagePattern: string): string {
  return `^${HOST_ESCAPE}${HOST_LINE_PREFIX}${messagePattern}${HOST_ESCAPE}[[:space:]]*$`;
}
