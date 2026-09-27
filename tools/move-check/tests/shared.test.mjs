import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CheckError,
  EXIT,
  UsageError,
  applyPrefixMaps,
  countOf,
  diffJson,
  formatJsonPath,
  formatJsonValue,
  isAllowedPath,
  normalizeRelativePath,
  parseOptions,
  parsePrefixMaps,
  requireOption,
  runCli,
  runCommand,
  splitPair,
} from '../lib/shared.mjs';

describe('splitPair', () => {
  it('splits at the first equals sign', () => {
    assert.deepEqual(splitPair('KEY=a=b', '--env'), ['KEY', 'a=b']);
  });

  it('refuses a value without an equals sign and names the flag', () => {
    assert.throws(() => splitPair('web2-admin', '--map'), (error) => error instanceof UsageError && /--map/.test(error.message));
  });
});

describe('normalizeRelativePath', () => {
  it('drops a leading ./ and trailing slashes', () => {
    assert.equal(normalizeRelativePath('./apps/web2-admin//'), 'apps/web2-admin');
  });

  it('writes the root as an empty path', () => {
    assert.equal(normalizeRelativePath('.'), '');
    assert.equal(normalizeRelativePath('./'), '');
    assert.equal(normalizeRelativePath(''), '');
  });
});

describe('parsePrefixMaps', () => {
  it('orders the rules longest old prefix first', () => {
    const rules = parsePrefixMaps(['a=x', 'a/b/c=z', 'a/b=y']);
    assert.deepEqual(
      rules.map((rule) => rule.from),
      ['a/b/c', 'a/b', 'a'],
    );
  });

  it('ignores trailing slashes on both sides', () => {
    assert.deepEqual(parsePrefixMaps(['web2-admin/=apps/web2-admin/']), [{ from: 'web2-admin', to: 'apps/web2-admin' }]);
  });

  it('reads "." and "./" as the root', () => {
    assert.deepEqual(parsePrefixMaps(['./=apps/project']), [{ from: '', to: 'apps/project' }]);
  });

  it('refuses the same old prefix twice', () => {
    assert.throws(() => parsePrefixMaps(['a=x', 'a/=y']), UsageError);
  });

  it('returns no rules when no map was given', () => {
    assert.deepEqual(parsePrefixMaps(undefined), []);
  });
});

describe('applyPrefixMaps', () => {
  const rules = parsePrefixMaps(['web2-admin=apps/web2-admin', 'web2-admin/backend=apps/api', 'README.md=docs/README.md']);

  it('renames a path under a mapped directory', () => {
    assert.equal(applyPrefixMaps('web2-admin/common/src/index.ts', rules), 'apps/web2-admin/common/src/index.ts');
  });

  it('uses the longest prefix that matches', () => {
    assert.equal(applyPrefixMaps('web2-admin/backend/src/app.ts', rules), 'apps/api/src/app.ts');
  });

  it('renames a single mapped file', () => {
    assert.equal(applyPrefixMaps('README.md', rules), 'docs/README.md');
  });

  it('leaves a path that only shares its first characters with a prefix', () => {
    assert.equal(applyPrefixMaps('web2-admin-old/notes.md', rules), 'web2-admin-old/notes.md');
  });

  it('leaves a path no rule names', () => {
    assert.equal(applyPrefixMaps('deploy/deploy.sh', rules), 'deploy/deploy.sh');
  });

  it('places every path under the new prefix when the old one is the root', () => {
    assert.equal(applyPrefixMaps('src/a.ts', parsePrefixMaps(['=apps/project'])), 'apps/project/src/a.ts');
  });

  it('lifts a directory to the root when the new prefix is empty', () => {
    assert.equal(applyPrefixMaps('apps/project/src/a.ts', parsePrefixMaps(['apps/project='])), 'src/a.ts');
  });
});

describe('isAllowedPath', () => {
  it('matches an exact path', () => {
    assert.equal(isAllowedPath('pnpm-lock.yaml', ['pnpm-lock.yaml']), true);
  });

  it('matches everything under a prefix that ends in a slash', () => {
    assert.equal(isAllowedPath('docs/guide/a.md', ['docs/']), true);
  });

  it('does not read a path without a trailing slash as a prefix', () => {
    assert.equal(isAllowedPath('docs/a.md', ['docs']), false);
  });

  it('matches nothing when nothing is allowed', () => {
    assert.equal(isAllowedPath('a', []), false);
  });
});

describe('diffJson', () => {
  it('finds nothing in equal values, whatever the key order', () => {
    assert.deepEqual(diffJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), []);
  });

  it('names each differing leaf with the value on each side', () => {
    assert.deepEqual(diffJson({ services: { api: { image: 'a' } } }, { services: { api: { image: 'b' } } }), [
      { path: ['services', 'api', 'image'], before: 'a', after: 'b' },
    ]);
  });

  it('reports a key on one side only as absent on the other', () => {
    assert.deepEqual(diffJson({ a: 1 }, { a: 1, b: 2 }), [{ path: ['b'], before: undefined, after: 2 }]);
  });

  it('compares arrays position by position', () => {
    assert.deepEqual(diffJson(['x', 'y'], ['x', 'z', 'w']), [
      { path: [1], before: 'y', after: 'z' },
      { path: [2], before: undefined, after: 'w' },
    ]);
  });

  it('tells null from an absent key', () => {
    assert.deepEqual(diffJson({ a: null }, {}), [{ path: ['a'], before: null, after: undefined }]);
  });

  it('reports a change of kind at the node where it happens', () => {
    assert.deepEqual(diffJson({ a: [1] }, { a: { 0: 1 } }), [{ path: ['a'], before: [1], after: { 0: 1 } }]);
  });
});

describe('formatJsonPath', () => {
  it('joins plain keys with dots and indexes with brackets', () => {
    assert.equal(formatJsonPath(['services', 'api', 'volumes', 0, 'source']), 'services.api.volumes[0].source');
  });

  it('keeps hyphens in plain keys', () => {
    assert.equal(formatJsonPath(['volumes', 'pg-data', 'name']), 'volumes.pg-data.name');
  });

  it('quotes a key that holds a dot or a space', () => {
    assert.equal(formatJsonPath(['labels', 'com.example.commit']), 'labels["com.example.commit"]');
  });

  it('names the whole document when the path is empty', () => {
    assert.equal(formatJsonPath([]), '(the whole document)');
  });
});

describe('formatJsonValue', () => {
  it('prints a present value as JSON', () => {
    assert.equal(formatJsonValue({ a: 'b' }), '{"a":"b"}');
  });

  it('prints an absent value as a word', () => {
    assert.equal(formatJsonValue(undefined), '(absent)');
  });
});

describe('countOf', () => {
  it('uses the singular for one', () => {
    assert.equal(countOf(1, 'entry', 'entries'), '1 entry');
  });

  it('uses the plural for anything else', () => {
    assert.equal(countOf(0, 'entry', 'entries'), '0 entries');
    assert.equal(countOf(3, 'file'), '3 files');
  });
});

describe('parseOptions', () => {
  const spec = { from: { type: 'string' }, map: { type: 'string', multiple: true } };

  it('collects a repeated option into a list', () => {
    const options = parseOptions(['--from', 'HEAD', '--map', 'a=b', '--map', 'c=d'], spec);
    assert.equal(options.from, 'HEAD');
    assert.deepEqual(options.map, ['a=b', 'c=d']);
  });

  it('accepts --help and -h', () => {
    assert.equal(parseOptions(['--help'], spec).help, true);
    assert.equal(parseOptions(['-h'], spec).help, true);
  });

  it('turns an unknown option into a UsageError', () => {
    assert.throws(() => parseOptions(['--frum', 'HEAD'], spec), UsageError);
  });

  it('turns a stray positional argument into a UsageError', () => {
    assert.throws(() => parseOptions(['HEAD'], spec), UsageError);
  });
});

describe('requireOption', () => {
  it('returns the value when it is there', () => {
    assert.equal(requireOption({ from: 'HEAD' }, 'from'), 'HEAD');
  });

  it('names the missing option in a UsageError', () => {
    assert.throws(() => requireOption({}, 'to'), (error) => error instanceof UsageError && /--to/.test(error.message));
  });
});

describe('runCommand', () => {
  it('returns what the command printed', () => {
    assert.equal(runCommand(process.execPath, ['-e', 'process.stdout.write("hello")']), 'hello');
  });

  it('returns raw bytes when asked for a buffer', () => {
    const output = runCommand(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0, 255]))'], { encoding: 'buffer' });
    assert.deepEqual([...output], [0, 255]);
  });

  it('reports a program that is not installed as a CheckError', () => {
    assert.throws(
      () => runCommand('move-check-no-such-program', []),
      (error) => error instanceof CheckError && /move-check-no-such-program was not found/.test(error.message),
    );
  });

  it('reports a failing command with its exit code and both streams', () => {
    const script = 'console.log("to stdout"); console.error("to stderr"); process.exit(3)';
    assert.throws(
      () => runCommand(process.execPath, ['-e', script]),
      (error) =>
        error instanceof CheckError &&
        /exit 3/.test(error.message) &&
        /to stderr/.test(error.message) &&
        /to stdout/.test(error.message),
    );
  });
});

describe('runCli', () => {
  function captureStderr(t) {
    const written = [];
    t.mock.method(process.stderr, 'write', (text) => {
      written.push(String(text));
      return true;
    });
    return written;
  }

  it('returns the exit code main returns', async () => {
    assert.equal(await runCli('usage', async () => EXIT.DIFFERENCE, []), 1);
  });

  it('prints the message and the usage for a UsageError and exits 2', async (t) => {
    const written = captureStderr(t);
    const code = await runCli('Usage: tool --x', async () => {
      throw new UsageError('--x is required');
    }, []);
    assert.equal(code, 2);
    assert.match(written.join(''), /--x is required[\s\S]*Usage: tool --x/);
  });

  it('prints only the message for a CheckError and exits 2', async (t) => {
    const written = captureStderr(t);
    const code = await runCli('Usage: tool', async () => {
      throw new CheckError('no such revision');
    }, []);
    assert.equal(code, 2);
    assert.equal(written.join(''), 'no such revision\n');
  });

  it('exits 2, never 1, when something unexpected breaks', async (t) => {
    const written = captureStderr(t);
    const code = await runCli('Usage: tool', async () => {
      throw new TypeError('boom');
    }, []);
    assert.equal(code, 2);
    assert.match(written.join(''), /TypeError: boom/);
  });
});

describe('EXIT', () => {
  it('uses 0 for a match, 1 for a difference and 2 when the check cannot run', () => {
    assert.deepEqual({ ...EXIT }, { MATCH: 0, DIFFERENCE: 1, CANNOT_CHECK: 2, HELP: 0 });
  });
});
