import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Spellings that reach the unbounded global. The bare form needs the leading guard so a method named
 * `fetch` on some other object does not count, and the three explicit globals need naming precisely
 * because that guard would otherwise wave them through: `window.fetch(` has a dot before `fetch` just
 * as `cache.fetch(` does.
 */
const UNBOUNDED_CALL = /(^|[^.\w])fetch\s*\(|\b(?:window|globalThis|self)\s*\.\s*fetch\s*\(/;

// Every read is bounded by the Swarm client's provider, and nothing stops a file from calling the
// global fetch around it, so that guarantee has to be asserted rather than designed in.
describe('the client makes no unbounded requests', () => {
  it('has no call to the global fetch left in src', () => {
    const offenders = sourceFiles(SRC_DIR)
      .flatMap((path) =>
        readFileSync(path, 'utf8')
          .split('\n')
          .map((line, index) => ({ path, line: line.trim(), number: index + 1 }))
          .filter(({ line }) => UNBOUNDED_CALL.test(line) && !/\basync\s+fetch\s*\(/.test(line)),
      )
      .map(({ path, number, line }) => `${path.slice(SRC_DIR.length + 1)}:${number}: ${line}`);

    expect(offenders, 'these reach the network with no timeout, read through the Swarm client instead').toEqual([]);
  });

  it.each(['fetch(url)', 'window.fetch(url)', 'globalThis.fetch(url)', 'self.fetch(url)', 'await fetch(`${a}/b`)'])(
    'recognises %s as an unbounded call',
    (spelling) => {
      expect(UNBOUNDED_CALL.test(spelling)).toBe(true);
    },
  );

  it.each(['cache.fetch(url)', 'manifestFetcher.fetch(url)', 'this.answerPath(path)'])(
    'does not mistake %s for one',
    (spelling) => {
      expect(UNBOUNDED_CALL.test(spelling)).toBe(false);
    },
  );
});
