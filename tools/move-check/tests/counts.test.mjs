import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CheckError, parsePrefixMaps } from '../lib/shared.mjs';
import { UNNAMED_PACKAGE, findCountProblems, parseTestLog, stripAnsi } from '../counts.mjs';
import { makeTempDir, runScript } from './support/fixtures.mjs';

const COUNTS = 'counts.mjs';

/** node:test's TAP summary, as it prints when its output is not a terminal. */
function tapSummary({ tests, pass = tests, fail = 0, cancelled = 0, skipped = 0, todo = 0, suites = 0 }) {
  return [
    `1..${tests}`,
    `# tests ${tests}`,
    `# suites ${suites}`,
    `# pass ${pass}`,
    `# fail ${fail}`,
    `# cancelled ${cancelled}`,
    `# skipped ${skipped}`,
    `# todo ${todo}`,
    '# duration_ms 51.2',
  ];
}

/** Lines of a pnpm recursive run for one package: the header, then every line under its prefix. */
function pnpmPackage(dir, lines, script = 'test') {
  return [`${dir} ${script}$ tsx --test`, ...lines.map((line) => `${dir} ${script}: ${line}`), `${dir} ${script}: Done`];
}

/** Interleaves two packages' lines the way a parallel pnpm run does. */
function interleave(first, second) {
  return Array.from({ length: Math.max(first.length, second.length) }, (_, index) => [first[index], second[index]])
    .flat()
    .filter((line) => line !== undefined);
}

function recursiveLog(prefix = 'web2-admin') {
  return [
    'Scope: 3 of 4 workspace projects',
    ...interleave(
      pnpmPackage(`${prefix}/common`, ['TAP version 13', '# Subtest: contract', 'ok 1 - contract', ...tapSummary({ tests: 5 })]),
      pnpmPackage(`${prefix}/backend`, ['TAP version 13', ...tapSummary({ tests: 40, suites: 6, skipped: 1, pass: 39 })]),
    ),
    ...pnpmPackage(
      `${prefix}/frontend`,
      [' RUN  v2.1.9 /repo/frontend', ' Test Files  3 passed (3)', '      Tests  21 passed (21)', '   Start at  10:00:00', '   Duration  1.52s'],
      'test',
    ),
  ].join('\n');
}

function writeLog(dir, name, text) {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

describe('stripAnsi', () => {
  it('removes colour codes and terminal hyperlinks', () => {
    assert.equal(stripAnsi('\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m3 passed\u001b[39m\u001b[22m'), ' Test Files  3 passed');
    assert.equal(stripAnsi('\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007'), 'link');
  });
});

describe('parseTestLog', () => {
  it('reads a TAP summary printed with no package name', () => {
    const summaries = parseTestLog(['TAP version 13', ...tapSummary({ tests: 3, skipped: 1, pass: 2 })].join('\n'));
    assert.deepEqual([...summaries.keys()], [UNNAMED_PACKAGE]);
    assert.deepEqual(summaries.get(UNNAMED_PACKAGE), [
      { runner: 'node:test', counts: { tests: 3, suites: 0, pass: 2, fail: 0, cancelled: 0, skipped: 1, todo: 0 } },
    ]);
  });

  it('reads the spec summary with its colour codes', () => {
    const log = ['\u001b[34mℹ tests 4\u001b[39m', '\u001b[34mℹ pass 4\u001b[39m', '\u001b[34mℹ fail 0\u001b[39m'].join('\n');
    assert.deepEqual(parseTestLog(log).get(UNNAMED_PACKAGE), [{ runner: 'node:test', counts: { tests: 4, pass: 4, fail: 0 } }]);
  });

  it('keys each summary by the directory a pnpm recursive run prints, however the lines interleave', () => {
    const summaries = parseTestLog(recursiveLog());
    assert.deepEqual([...summaries.keys()].sort(), ['web2-admin/backend', 'web2-admin/common', 'web2-admin/frontend']);
    assert.equal(summaries.get('web2-admin/common')[0].counts.tests, 5);
    assert.equal(summaries.get('web2-admin/backend')[0].counts.skipped, 1);
    assert.deepEqual(summaries.get('web2-admin/frontend'), [
      { runner: 'vitest', counts: { 'files passed': 3, 'files total': 3, 'tests passed': 21, 'tests total': 21 } },
    ]);
  });

  it('reads every part of a vitest summary, errors included', () => {
    const log = [
      ' \u001b[2mTest Files \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m2 passed\u001b[39m\u001b[22m\u001b[90m (3)\u001b[39m',
      '      Tests  2 failed | 17 passed | 1 skipped | 1 todo (21)',
      '     Errors  1 error',
    ].join('\n');
    assert.deepEqual(parseTestLog(log).get(UNNAMED_PACKAGE), [
      {
        runner: 'vitest',
        counts: {
          'files failed': 1,
          'files passed': 2,
          'files total': 3,
          'tests failed': 2,
          'tests passed': 17,
          'tests skipped': 1,
          'tests todo': 1,
          'tests total': 21,
          errors: 1,
        },
      },
    ]);
  });

  it('reads a vitest run that found no tests', () => {
    assert.deepEqual(parseTestLog(' Test Files  no tests\n      Tests  no tests').get(UNNAMED_PACKAGE), [
      { runner: 'vitest', counts: { 'files total': 0, 'tests total': 0 } },
    ]);
  });

  it('names the package from a "> name@version script" banner', () => {
    const log = ['> @streaming-monorepo/web2-admin-backend@0.1.0 test /repo/web2-admin/backend', '> tsx --test', '', ...tapSummary({ tests: 2 })].join('\n');
    assert.deepEqual([...parseTestLog(log).keys()], ['@streaming-monorepo/web2-admin-backend']);
  });

  it('does not read a line as a pnpm prefix unless pnpm printed that package header first', () => {
    const log = ['Error message: # tests 99', ...tapSummary({ tests: 1 })].join('\n');
    const summaries = parseTestLog(log);
    assert.deepEqual([...summaries.keys()], [UNNAMED_PACKAGE]);
    assert.equal(summaries.get(UNNAMED_PACKAGE)[0].counts.tests, 1);
  });

  it('strips the timestamps a CI log puts in front of each line', () => {
    const stamped = recursiveLog()
      .split('\n')
      .map((line) => `2026-09-27T01:02:03.4567890Z ${line}`)
      .join('\n');
    assert.deepEqual(parseTestLog(stamped), parseTestLog(recursiveLog()));
  });

  it('keeps two summaries of one package in the order they were printed', () => {
    const log = pnpmPackage('web2-admin/backend', [...tapSummary({ tests: 3 }), ...tapSummary({ tests: 7 })]).join('\n');
    assert.deepEqual(
      parseTestLog(log)
        .get('web2-admin/backend')
        .map((summary) => summary.counts.tests),
      [3, 7],
    );
  });
});

describe('findCountProblems', () => {
  const log = (text) => parseTestLog(text);

  it('finds nothing when every package has the same counts and nothing failed', () => {
    assert.deepEqual(findCountProblems(log(recursiveLog()), log(recursiveLog())), []);
  });

  it('names a counter that changed with both values', () => {
    const after = recursiveLog().replace('# tests 5', '# tests 4');
    assert.deepEqual(findCountProblems(log(recursiveLog()), log(after)), ['web2-admin/common: node:test counts differ: tests 5 vs 4']);
  });

  it('names a package that one log has and the other lacks', () => {
    const after = recursiveLog()
      .split('\n')
      .filter((line) => !line.startsWith('web2-admin/frontend'))
      .join('\n');
    assert.deepEqual(findCountProblems(log(recursiveLog()), log(after)), ['web2-admin/frontend: only in the before log']);
  });

  it('reports a failure even when both logs agree on it', () => {
    const failing = pnpmPackage('web2-admin/backend', tapSummary({ tests: 40, pass: 39, fail: 1 })).join('\n');
    const problems = findCountProblems(log(failing), log(failing));
    assert.deepEqual(problems, ['web2-admin/backend: node:test failed in the before log: fail 1', 'web2-admin/backend: node:test failed in the after log: fail 1']);
  });

  it('renames the before log packages with the maps, longest prefix first', () => {
    const problems = findCountProblems(log(recursiveLog()), log(recursiveLog('apps/web2-admin')), parsePrefixMaps(['web2-admin=apps/web2-admin']));
    assert.deepEqual(problems, []);
  });

  it('refuses a map that sends two packages to one name', () => {
    assert.throws(
      () => findCountProblems(log(recursiveLog()), log(recursiveLog()), parsePrefixMaps(['web2-admin/common=x', 'web2-admin/backend=x'])),
      CheckError,
    );
  });

  it('names a package whose number of summaries changed', () => {
    const before = pnpmPackage('web2-admin/backend', [...tapSummary({ tests: 3 }), ...tapSummary({ tests: 7 })]).join('\n');
    const after = pnpmPackage('web2-admin/backend', tapSummary({ tests: 3 })).join('\n');
    assert.deepEqual(findCountProblems(log(before), log(after)), ['web2-admin/backend: 2 summaries in the before log, 1 in the after log']);
  });
});

describe('counts.mjs', () => {
  it('passes two logs with the same counts on one line', (t) => {
    const dir = makeTempDir(t);
    const args = ['--before', writeLog(dir, 'before.log', recursiveLog()), '--after', writeLog(dir, 'after.log', recursiveLog())];
    const result = runScript(COUNTS, args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'counts: match, 3 packages, 3 summaries, 66 tests, none failed\n');
  });

  it('lists what differs and exits 1', (t) => {
    const dir = makeTempDir(t);
    const after = recursiveLog().replace('Tests  21 passed (21)', 'Tests  2 failed | 19 passed (21)');
    const result = runScript(COUNTS, ['--before', writeLog(dir, 'before.log', recursiveLog()), '--after', writeLog(dir, 'after.log', after)]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^web2-admin\/frontend: vitest counts differ: tests failed \(absent\) vs 2, tests passed 21 vs 19$/m);
    assert.match(result.stdout, /^web2-admin\/frontend: vitest failed in the after log: tests failed 2$/m);
    assert.match(result.stdout, /^counts: differs, 2 problems$/m);
  });

  it('passes a move once --map renames the package directories', (t) => {
    const dir = makeTempDir(t);
    const before = writeLog(dir, 'before.log', recursiveLog());
    const after = writeLog(dir, 'after.log', recursiveLog('apps/web2-admin'));
    const mapped = runScript(COUNTS, ['--before', before, '--after', after, '--map', 'web2-admin/=apps/web2-admin/']);
    assert.equal(mapped.status, 0, mapped.stdout);
    const unmapped = runScript(COUNTS, ['--before', before, '--after', after]);
    assert.equal(unmapped.status, 1);
    assert.match(unmapped.stdout, /^web2-admin\/backend: only in the before log$/m);
    assert.match(unmapped.stdout, /^apps\/web2-admin\/backend: only in the after log$/m);
  });

  it('exits 2 when neither log holds a summary it knows', (t) => {
    const dir = makeTempDir(t);
    const result = runScript(COUNTS, ['--before', writeLog(dir, 'a.log', 'hello\n'), '--after', writeLog(dir, 'b.log', 'world\n')]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Neither log holds a test summary/);
  });

  it('exits 2 for a log that cannot be read', (t) => {
    const dir = makeTempDir(t);
    const result = runScript(COUNTS, ['--before', join(dir, 'missing.log'), '--after', writeLog(dir, 'b.log', recursiveLog())]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--before .*missing\.log cannot be read/);
  });

  it('exits 2 with the usage when --after is missing', (t) => {
    const dir = makeTempDir(t);
    const result = runScript(COUNTS, ['--before', writeLog(dir, 'a.log', recursiveLog())]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--after is required/);
    assert.match(result.stderr, /Usage: node tools\/move-check\/counts\.mjs/);
  });
});
