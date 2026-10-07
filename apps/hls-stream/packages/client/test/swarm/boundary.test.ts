import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SRC = join(ROOT, 'src');
const SWARM = join(SRC, 'swarm');

/**
 * The parts of the app the Swarm layer must not reach into, so the app depends on it and never the
 * other way. `src/utils` is not among them: it holds what both sides share, such as the gateway clock.
 */
const APP = ['components', 'pages', 'providers', 'layouts', 'App.tsx', 'routes.tsx'].map((entry) => join(SRC, entry));

/** `import ... from 'x'`, `export ... from 'x'`, `import 'x'` and `import('x')`, type-only ones included. */
const SPECIFIERS = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;

function sourceFiles(path: string): string[] {
  if (/\.tsx?$/.test(path)) {
    return [path];
  }
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(child);
    }
    return /\.tsx?$/.test(entry.name) ? [child] : [];
  });
}

/** Where a specifier points inside the package, or null for a package of its own. */
function resolvedPath(specifier: string, importer: string): string | null {
  if (specifier.startsWith('@/')) {
    return join(SRC, specifier.slice(2));
  }
  return specifier.startsWith('.') ? resolve(dirname(importer), specifier) : null;
}

const isInApp = (target: string) =>
  APP.some((entry) => target === entry || target === entry.replace(/\.tsx$/, '') || target.startsWith(`${entry}/`));

function appImportsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(SPECIFIERS)]
    .map(([, specifier]) => specifier)
    .filter((specifier) => {
      const target = resolvedPath(specifier, file);
      return target !== null && isInApp(target);
    })
    .map((specifier) => `${relative(ROOT, file)} imports ${specifier}`);
}

describe('the Swarm layer', () => {
  it("imports nothing from the app's components, pages, providers or layouts", () => {
    const files = sourceFiles(SWARM);

    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap(appImportsOf)).toEqual([]);
  });
});
