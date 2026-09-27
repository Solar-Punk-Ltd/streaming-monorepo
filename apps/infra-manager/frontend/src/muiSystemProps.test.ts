/**
 * That no style reaches Box, Stack, Typography or Link as a prop of its own,
 * checked by reading the source.
 *
 * MUI 9 removed those props. A removed prop on Box or Stack fails the type
 * check, but Typography still takes `color` for a palette name such as `error`
 * and quietly ignores a palette path such as `error.main`, so text written that
 * way falls back to the default colour with nothing to say so. That is how the
 * move to MUI 9 first lost fifteen warning and error colours. Styles go in `sx`.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const STYLED_COMPONENTS = ['Box', 'Stack', 'Typography', 'Link', 'DialogContentText'];
const STYLE_PROPS = [
  'color', 'bgcolor', 'fontWeight', 'fontFamily', 'fontSize', 'textAlign', 'display', 'whiteSpace',
  'lineHeight', 'letterSpacing', 'width', 'height', 'minWidth', 'maxWidth', 'gap', 'alignItems',
  'justifyContent', 'flexWrap', 'flex', 'm', 'mt', 'mb', 'ml', 'mr', 'mx', 'my', 'p', 'pt', 'pb',
  'pl', 'pr', 'px', 'py',
];
const OPENING_TAG = new RegExp(`<(${STYLED_COMPONENTS.join('|')})\\b([^>]*?)\\s(${STYLE_PROPS.join('|')})=`, 'g');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!entry.name.endsWith('.tsx')) return [];
    return [full];
  });
}

it('gives Box, Stack, Typography and Link their styles through sx only', () => {
  const found = sourceFiles(SOURCE_ROOT).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(OPENING_TAG)].map((match) => {
      const line = text.slice(0, match.index).split('\n').length;
      return `${path.relative(SOURCE_ROOT, file)}:${line} <${match[1]} ${match[3]}=`;
    });
  });
  assert.deepEqual(found, []);
});
