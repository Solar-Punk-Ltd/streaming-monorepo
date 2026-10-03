/**
 * LOG_LEVEL: how much the manager logs.
 *
 * Unit test, no database. `pnpm test` in manager/.
 *
 * The setting was read and printed at boot and never applied, so every debug
 * line printed whatever it said: about 11.7 MB of console in a day on one
 * host. The logger now drops what is below the configured level, and the
 * config refuses a level it does not know, for the reason it refuses a
 * malformed CHEQUEBOOK_FLOOR_BZZ.
 */
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import { DEFAULT_LOG_LEVEL, LOG_LEVELS, Logger, type LogLevel } from '../../src/domain/Logger.js';
import { config, logLevel } from '../../src/utils/config.js';

/** The label of every line the logger wrote while `write` ran, at `level`, in order. */
function labelsWritten(t: TestContext, level: LogLevel | null, write: (logger: Logger) => void): string[] {
  const lines: string[] = [];
  for (const method of ['debug', 'log', 'info', 'warn', 'error'] as const) {
    t.mock.method(console, method, (line: string) => void lines.push(line));
  }
  const logger = Logger.getInstance();
  const previous = level === null ? null : logger.setLevel(level);
  try {
    write(logger);
  } finally {
    if (previous !== null) logger.setLevel(previous);
    t.mock.restoreAll();
  }
  return lines.map((line) => /^\[[^\]]+\] \[([A-Z]+)\] - /.exec(line)?.[1] ?? line);
}

/** One line from each of the logger's methods, least severe first. */
function oneOfEach(logger: Logger): void {
  logger.debug('a debug line');
  logger.log('a log line');
  logger.info('an info line');
  logger.warn('a warn line');
  logger.error('an error line');
}

/** What each level lets through. `log` is an info line by another name, and nothing logs at trace. */
const WRITTEN_AT: Record<LogLevel, string[]> = {
  trace: ['DEBUG', 'LOG', 'INFO', 'WARN', 'ERROR'],
  debug: ['DEBUG', 'LOG', 'INFO', 'WARN', 'ERROR'],
  info: ['LOG', 'INFO', 'WARN', 'ERROR'],
  warn: ['WARN', 'ERROR'],
  error: ['ERROR'],
};

describe('the level the logger writes at', () => {
  // First in the file: the logger is one per process, and every case after this one sets a level.
  it('is info before anything sets one, so a debug line is dropped', (t) => {
    assert.equal(DEFAULT_LOG_LEVEL, 'info');
    assert.deepEqual(labelsWritten(t, null, oneOfEach), WRITTEN_AT.info);
  });

  it('runs from trace to error', () => {
    assert.deepEqual([...LOG_LEVELS], ['trace', 'debug', 'info', 'warn', 'error']);
  });

  for (const level of LOG_LEVELS) {
    it(`at ${level}, writes ${WRITTEN_AT[level].join(', ')} and nothing else`, (t) => {
      assert.deepEqual(labelsWritten(t, level, oneOfEach), WRITTEN_AT[level]);
    });
  }

  it('keeps the format of a line it writes', (t) => {
    const lines: string[] = [];
    t.mock.method(console, 'debug', (line: string) => void lines.push(line));
    t.mock.method(console, 'log', (line: string) => void lines.push(line));
    const logger = Logger.getInstance();
    const previous = logger.setLevel('debug');
    try {
      logger.debug('[Probe] read', { slot: 3 });
      logger.log('[Probe] plain');
    } finally {
      logger.setLevel(previous);
    }

    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0]!, /^\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\] \[DEBUG\] - \[Probe\] read \{"slot":3\}$/);
    assert.match(lines[1]!, /^\[[^\]]+\] \[LOG\] - \[Probe\] plain$/);
  });

  // Last of the cases that read what the logger writes, since the switch to standard error has no way back.
  it('drops the same lines when everything goes to standard error', (t) => {
    Logger.getInstance().writeEverythingToStandardError();
    const errors: string[] = [];
    t.mock.method(console, 'error', (line: string) => void errors.push(line));
    for (const method of ['debug', 'log', 'info', 'warn'] as const) {
      t.mock.method(console, method, () => assert.fail(`console.${method} was called`));
    }
    const logger = Logger.getInstance();
    const previous = logger.setLevel('warn');
    try {
      oneOfEach(logger);
    } finally {
      logger.setLevel(previous);
    }

    assert.deepEqual(
      errors.map((line) => /\[([A-Z]+)\] - /.exec(line)?.[1]),
      ['WARN', 'ERROR'],
    );
  });
});

describe('the level the manager is configured with', () => {
  it('is info when the operator set nothing', () => {
    for (const empty of [undefined, '', '   ']) {
      assert.equal(logLevel(empty), 'info');
    }
  });

  it('takes each level, trimmed and in either case', () => {
    for (const level of LOG_LEVELS) {
      assert.equal(logLevel(level), level);
      assert.equal(logLevel(`  ${level.toUpperCase()}  `), level);
    }
  });

  it('stops the manager on a level it does not know, and names the setting and the levels', () => {
    for (const unknown of ['verbose', 'warning', 'log', 'constructor', '__proto__', 'info,debug']) {
      assert.throws(
        () => logLevel(unknown),
        (err: Error) => /LOG_LEVEL/.test(err.message) && err.message.includes('trace, debug, info, warn, error'),
        unknown,
      );
    }
  });

  it('is what the manager’s config carries, read from the environment once', () => {
    assert.equal(config.logLevel, logLevel(process.env.LOG_LEVEL));
  });
});
