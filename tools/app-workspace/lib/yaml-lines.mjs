/**
 * The few YAML shapes pnpm writes into pnpm-lock.yaml, and a person into pnpm-workspace.yaml, read one line at a time.
 * The tool edits those files as text, so every line it does not change stays byte for byte as it was.
 */

/** How many spaces a line starts with. */
export function indentOf(line) {
  return line.length - line.trimStart().length;
}

/** @typedef {{ value: string, length: number, quote: "'" | '"' | '' }} Key  A key's value, the length of its spelling, and its quote. */

function readSingleQuoted(text) {
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] !== "'") continue;
    if (text[index + 1] === "'") {
      index += 1;
      continue;
    }
    return { value: text.slice(1, index).replaceAll("''", "'"), length: index + 1, quote: "'" };
  }
  return null;
}

function readDoubleQuoted(text) {
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] === '"') return { value: JSON.parse(text.slice(0, index + 1)), length: index + 1, quote: '"' };
  }
  return null;
}

/** A plain key ends at the first colon that a space or the end of the line follows. */
function readPlainKey(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === ':' && (index + 1 === text.length || text[index + 1] === ' ')) {
      return index === 0 ? null : { value: text.slice(0, index), length: index, quote: '' };
    }
  }
  return null;
}

/**
 * The key a mapping line starts with, once its indentation is taken off, or null when the text is no `key:` line.
 * @returns {Key | null}
 */
export function readKey(text) {
  const key = text.startsWith("'") ? readSingleQuoted(text) : text.startsWith('"') ? readDoubleQuoted(text) : readPlainKey(text);
  return key !== null && text[key.length] === ':' ? key : null;
}

/**
 * A scalar value as written after a key's colon or a list item's dash: quoted, or plain up to a ` #` comment.
 * @returns {{ value: string, quote: "'" | '"' | '' }}
 */
export function readScalar(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("'")) {
    const quoted = readSingleQuoted(trimmed);
    if (quoted !== null) return { value: quoted.value, quote: "'" };
  }
  if (trimmed.startsWith('"')) {
    const quoted = readDoubleQuoted(trimmed);
    if (quoted !== null) return { value: quoted.value, quote: '"' };
  }
  const comment = trimmed.indexOf(' #');
  return { value: comment === -1 ? trimmed : trimmed.slice(0, comment).trimEnd(), quote: '' };
}

/** Spells a value in the quote it had, so a renamed key or glob reads as the one it replaces. */
export function spell(value, quote) {
  if (quote === "'") return `'${value.replaceAll("'", "''")}'`;
  if (quote === '"') return JSON.stringify(value);
  return value;
}
