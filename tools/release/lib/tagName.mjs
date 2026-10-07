// A tag name a deploy can carry into a shell on a host and into a page without quoting it. Any naming scheme fits:
// letters and digits first, then letters, digits and . _ + / -, at most 80 characters, and none of what git refuses
// in a ref name within that set: "..", "//", "/.", a trailing "." or "/", or a part ending in ".lock".
export const TAG_NAME_MAX_LENGTH = 80;

const SHAPE = /^[A-Za-z0-9][A-Za-z0-9._+/-]*$/;

// Answers what is wrong with a name, as the end of a sentence that starts with the name, or null when nothing is.
export function tagNameProblem(name) {
  if (typeof name !== 'string' || name === '') return 'is empty';
  if (name.length > TAG_NAME_MAX_LENGTH) return `is longer than ${TAG_NAME_MAX_LENGTH} characters`;
  if (!SHAPE.test(name)) {
    return 'may hold only letters, digits and . _ + / -, and must start with a letter or a digit';
  }
  if (name.includes('..') || name.includes('//') || name.includes('/.')) return 'may not hold "..", "//" or "/."';
  if (name.endsWith('.') || name.endsWith('/')) return 'may not end with "." or "/"';
  if (name.split('/').some((part) => part.endsWith('.lock'))) return 'may not have a part that ends in ".lock"';
  return null;
}

export function isSafeTagName(name) {
  return tagNameProblem(name) === null;
}
