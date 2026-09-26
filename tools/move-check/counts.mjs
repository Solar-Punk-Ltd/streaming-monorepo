import { readFileSync } from 'node:fs';

import {
  CheckError,
  EXIT,
  applyPrefixMaps,
  countOf,
  parseOptions,
  parsePrefixMaps,
  requireOption,
  runWhenStarted,
  showHelp,
} from './lib/shared.mjs';

const USAGE = `Usage: node tools/move-check/counts.mjs --before <log> --after <log> [--map <old-prefix>=<new-prefix>]...

Reads two test-run logs and compares the counts in every test summary it
recognises, package by package. It reads node:test's TAP and spec summaries
(tests, suites, pass, fail, cancelled, skipped, todo) and vitest's Test Files,
Tests and Errors lines, with colour codes and CI timestamps stripped.

A summary belongs to the package printed before it: the directory a pnpm
recursive run puts in front of every line, or the name in a
"> name@version script" banner.

  --map   renames package directories in the before log, because a move changes
          the directory pnpm prints. The longest matching prefix wins.

The check passes when every package has the same counts in both logs and no
test failed, was cancelled or raised an error in either.

Exit codes: 0 match, 1 difference, 2 the check could not run.`;

const OPTION_SPECS = {
  before: { type: 'string' },
  after: { type: 'string' },
  map: { type: 'string', multiple: true },
};

/** The package a summary belongs to when the log names none before it. */
export const UNNAMED_PACKAGE = '(no package name)';

const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** A CI log line may start with a timestamp, and a downloaded job log puts the job and step names before that. */
const CI_LINE_PREFIX = /^(?:[^\t]*\t[^\t]*\t)?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
/** pnpm announces each package of a recursive run as `<dir> <script>$ <command>` and then prefixes its lines. */
const PNPM_PACKAGE_HEADER = /^(\S+) (\S+)\$ /;
const RUN_BANNER = /^> ((?:@[^@\s/]+\/)?[^@\s]+)@\S+ \S+/;
const NODE_TEST_COUNTER = /^(?:#|ℹ) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/;
const VITEST_COUNT_LINE = /^\s*(Test Files|Tests)\s+(.+)$/;
const VITEST_ERRORS_LINE = /^\s*Errors\s+(\d+) errors?$/;
const VITEST_STATE = /^(\d+) ([a-z][a-z ]*)$/;
const VITEST_TOTAL = /^(.+) \((\d+)\)$/;

const VITEST_SCOPE = { 'Test Files': 'files', Tests: 'tests' };

const COUNTER_ORDER = [
  'tests',
  'suites',
  'pass',
  'fail',
  'cancelled',
  'skipped',
  'todo',
  'files failed',
  'files passed',
  'files skipped',
  'files todo',
  'files total',
  'tests failed',
  'tests passed',
  'tests skipped',
  'tests todo',
  'tests total',
  'errors',
];

/** Counters that mean a run did not pass when they are above zero. */
const FAILURE_COUNTERS = { 'node:test': ['fail', 'cancelled'], vitest: ['files failed', 'tests failed', 'errors'] };

/**
 * @typedef {{ runner: 'node:test' | 'vitest', counts: Record<string, number> }} TestSummary
 * @typedef {Map<string, TestSummary[]>} SummariesByPackage
 */

/** Removes terminal colour codes and hyperlinks. */
export function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE, '');
}

/** A line a terminal redrew with carriage returns ends up showing its last version. */
function lastRedraw(line) {
  const withoutEnding = line.endsWith('\r') ? line.slice(0, -1) : line;
  return withoutEnding.slice(withoutEnding.lastIndexOf('\r') + 1);
}

function cleanLine(rawLine) {
  return stripAnsi(lastRedraw(rawLine)).replace(CI_LINE_PREFIX, '').trimEnd();
}

function parseVitestState(scope, text) {
  const trimmed = text.trim();
  if (trimmed === 'no tests' || trimmed === `no ${scope}`) return { [`${scope} total`]: 0 };
  const total = VITEST_TOTAL.exec(trimmed);
  if (!total) return null;
  const states = total[1].split(' | ').map((segment) => VITEST_STATE.exec(segment.trim()));
  if (states.includes(null)) return null;
  return {
    ...Object.fromEntries(states.map(([, count, state]) => [`${scope} ${state}`, Number(count)])),
    [`${scope} total`]: Number(total[2]),
  };
}

/** Reads the counters one summary line holds, and whether that line opens a new summary. */
function readSummaryLine(content) {
  const nodeCounter = NODE_TEST_COUNTER.exec(content);
  if (nodeCounter) return { runner: 'node:test', counts: { [nodeCounter[1]]: Number(nodeCounter[2]) }, opens: nodeCounter[1] === 'tests' };
  const vitestCount = VITEST_COUNT_LINE.exec(content);
  if (vitestCount) {
    const counts = parseVitestState(VITEST_SCOPE[vitestCount[1]], vitestCount[2]);
    return counts && { runner: 'vitest', counts, opens: vitestCount[1] === 'Test Files' };
  }
  const vitestErrors = VITEST_ERRORS_LINE.exec(content);
  return vitestErrors && { runner: 'vitest', counts: { errors: Number(vitestErrors[1]) }, opens: false };
}

/** Adds a line's counters to the package's last summary, or opens a new summary when they cannot join it. */
function addCounters(list, { runner, counts, opens }) {
  const last = list.at(-1);
  const joinsLast = !opens && last?.runner === runner && Object.keys(counts).every((name) => !(name in last.counts));
  return joinsLast ? [...list.slice(0, -1), { runner, counts: { ...last.counts, ...counts } }] : [...list, { runner, counts }];
}

function longestPrefixOf(line, prefixes) {
  return [...prefixes.keys()].filter((prefix) => line.startsWith(prefix)).sort((left, right) => right.length - left.length)[0];
}

/**
 * Reads every test summary in a log and groups them by the package printed before each one.
 * A pnpm prefix counts only after pnpm printed that package's header, so ordinary output that
 * happens to look like `word word: text` never names a package.
 * @returns {SummariesByPackage}
 */
export function parseTestLog(text) {
  const packageByPrefix = new Map();
  const summaries = new Map();
  let bannerPackage = UNNAMED_PACKAGE;
  for (const rawLine of text.split('\n')) {
    const line = cleanLine(rawLine);
    const header = PNPM_PACKAGE_HEADER.exec(line);
    if (header) {
      packageByPrefix.set(`${header[1]} ${header[2]}: `, header[1]);
      continue;
    }
    const prefix = longestPrefixOf(line, packageByPrefix);
    const banner = prefix === undefined ? RUN_BANNER.exec(line) : null;
    if (banner) {
      bannerPackage = banner[1];
      continue;
    }
    const summaryLine = readSummaryLine(prefix === undefined ? line : line.slice(prefix.length));
    if (!summaryLine) continue;
    const packageKey = prefix === undefined ? bannerPackage : packageByPrefix.get(prefix);
    summaries.set(packageKey, addCounters(summaries.get(packageKey) ?? [], summaryLine));
  }
  return summaries;
}

function renamePackages(summaries, rules) {
  const renamed = new Map();
  const originals = new Map();
  for (const [key, list] of summaries) {
    const newKey = key === UNNAMED_PACKAGE ? key : applyPrefixMaps(key, rules);
    if (renamed.has(newKey)) throw new CheckError(`--map sends both ${originals.get(newKey)} and ${key} to ${newKey}.`);
    renamed.set(newKey, list);
    originals.set(newKey, key);
  }
  return renamed;
}

function orderCounters(names) {
  const rank = (name) => (COUNTER_ORDER.includes(name) ? COUNTER_ORDER.indexOf(name) : COUNTER_ORDER.length);
  return names.toSorted((left, right) => rank(left) - rank(right) || left.localeCompare(right));
}

function formatCount(value) {
  return value === undefined ? '(absent)' : String(value);
}

function summaryLabel(list, summary, index) {
  return list.length > 1 ? `${summary.runner} summary ${index + 1}` : summary.runner;
}

function summaryDifference(key, before, after, label) {
  if (before.runner !== after.runner) return [`${key}: ${label} is ${before.runner} in the before log and ${after.runner} in the after log`];
  const names = orderCounters([...new Set([...Object.keys(before.counts), ...Object.keys(after.counts)])]);
  const changed = names.filter((name) => before.counts[name] !== after.counts[name]);
  if (changed.length === 0) return [];
  const described = changed.map((name) => `${name} ${formatCount(before.counts[name])} vs ${formatCount(after.counts[name])}`);
  return [`${key}: ${label} counts differ: ${described.join(', ')}`];
}

function failures(key, side, list) {
  return list.flatMap((summary, index) => {
    const failing = FAILURE_COUNTERS[summary.runner].filter((name) => (summary.counts[name] ?? 0) > 0);
    if (failing.length === 0) return [];
    const described = failing.map((name) => `${name} ${summary.counts[name]}`).join(', ');
    return [`${key}: ${summaryLabel(list, summary, index)} failed in the ${side} log: ${described}`];
  });
}

function packageProblems(key, beforeList, afterList) {
  if (beforeList === undefined) return [`${key}: only in the after log`];
  if (afterList === undefined) return [`${key}: only in the before log`];
  if (beforeList.length !== afterList.length) {
    return [`${key}: ${countOf(beforeList.length, 'summary', 'summaries')} in the before log, ${afterList.length} in the after log`];
  }
  const differences = beforeList.flatMap((summary, index) =>
    summaryDifference(key, summary, afterList[index], summaryLabel(beforeList, summary, index)),
  );
  return [...differences, ...failures(key, 'before', beforeList), ...failures(key, 'after', afterList)];
}

/**
 * Lists every way two logs' summaries disagree, package by package, and every failure on either side.
 * `rules` rename the before log's packages first.
 * @param {SummariesByPackage} before
 * @param {SummariesByPackage} after
 * @returns {string[]} one line per problem, empty when the logs match
 */
export function findCountProblems(before, after, rules = []) {
  const renamedBefore = renamePackages(before, rules);
  const keys = [...new Set([...renamedBefore.keys(), ...after.keys()])].sort();
  return keys.flatMap((key) => packageProblems(key, renamedBefore.get(key), after.get(key)));
}

function readLog(path, flag) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new CheckError(`${flag} ${path} cannot be read: ${error.message}`);
  }
}

function testsIn(summary) {
  return (summary.runner === 'vitest' ? summary.counts['tests total'] : summary.counts.tests) ?? 0;
}

/** Runs the counts check with command-line arguments and returns its exit code. */
export async function main(argv) {
  const options = parseOptions(argv, OPTION_SPECS);
  if (options.help) return showHelp(USAGE);
  const beforePath = requireOption(options, 'before');
  const afterPath = requireOption(options, 'after');
  const rules = parsePrefixMaps(options.map);
  const before = parseTestLog(readLog(beforePath, '--before'));
  const after = parseTestLog(readLog(afterPath, '--after'));
  if (before.size === 0 && after.size === 0) {
    throw new CheckError('Neither log holds a test summary this check knows: node:test TAP or spec output, or the vitest summary.');
  }
  const problems = findCountProblems(before, after, rules);
  if (problems.length > 0) {
    console.log([...problems, `counts: differs, ${countOf(problems.length, 'problem')}`].join('\n'));
    return EXIT.DIFFERENCE;
  }
  const summaries = [...after.values()].flat();
  const tests = summaries.reduce((total, summary) => total + testsIn(summary), 0);
  console.log(
    `counts: match, ${countOf(after.size, 'package')}, ${countOf(summaries.length, 'summary', 'summaries')}, ${countOf(tests, 'test')}, none failed`,
  );
  return EXIT.MATCH;
}

await runWhenStarted(import.meta.url, USAGE, main);
