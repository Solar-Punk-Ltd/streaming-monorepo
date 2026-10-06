import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  CLOCK_CHECK_INTERVAL_MS,
  CLOCK_MAX_ERROR_MS,
  CLOCK_RETRY_INTERVAL_MS,
  ClockCheck,
  judgeClock,
} from '../src/libs/ClockCheck.js';
import { ClockSample, ClockServer, parseClockServers } from '../src/libs/sntp.js';
import { CLOCK_PENDING, CLOCK_TRUSTED, CLOCK_UNCHECKED, CLOCK_UNTRUSTED } from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';
import { startFakeSntpServer } from './helpers/fakeSntpServer.js';

const SERVERS = parseClockServers('a.time.test,b.time.test,c.time.test');
const WALL_MS = Date.UTC(2026, 9, 6, 12, 0, 0);

const servers: { close(): Promise<void> }[] = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

function sample(server: string, offsetMs: number, delayMs: number): ClockSample {
  return { server, offsetMs, delayMs };
}

interface LogLine {
  level: 'info' | 'warn';
  message: string;
}

/**
 * What each server answers in the next round, keyed by host. A missing host, or an Error, is a server
 * that did not answer.
 */
type Script = Record<string, ClockSample | Error>;

interface Harness {
  check: ClockCheck;
  clock: FakeClock;
  logged: LogLine[];
  /** Hosts asked, in order, across every round. */
  asked: string[];
  /** Replaces what every server answers from the next round on. */
  answer(script: Script): void;
}

function harness(script: Script = {}): Harness {
  const clock = new FakeClock();
  const logged: LogLine[] = [];
  const asked: string[] = [];
  let current = script;

  const query = async (server: ClockServer): Promise<ClockSample> => {
    asked.push(server.host);
    const answer = current[server.host];
    if (answer === undefined) {
      throw new Error(`no answer within 2000 ms`);
    }
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };

  const check = new ClockCheck({
    servers: SERVERS,
    clock,
    now: () => WALL_MS + clock.now(),
    query,
    logger: {
      info: (message) => void logged.push({ level: 'info', message }),
      warn: (message) => void logged.push({ level: 'warn', message }),
    },
  });

  return {
    check,
    clock,
    logged,
    asked,
    answer: (next) => {
      current = next;
    },
  };
}

/** Lets the round started by a timer or by `start` settle, since its answers arrive as promises. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('the verdict of one round', () => {
  it('trusts a clock 10 ms off', () => {
    const round = judgeClock([sample('a', 10, 4)]);
    assert.equal(round.verdict, CLOCK_TRUSTED);
    assert.equal(round.errorBoundMs, 12);
  });

  it('distrusts a clock 300 ms off', () => {
    assert.equal(judgeClock([sample('a', 300, 4)]).verdict, CLOCK_UNTRUSTED);
    assert.equal(judgeClock([sample('a', -300, 4)]).verdict, CLOCK_UNTRUSTED);
  });

  it('trusts a clock whose whole bound, offset plus half the round trip, is inside the limit', () => {
    assert.equal(judgeClock([sample('a', 10, 20)]).verdict, CLOCK_TRUSTED);
    assert.equal(judgeClock([sample('a', 200, 100)]).verdict, CLOCK_TRUSTED);
    assert.equal(CLOCK_MAX_ERROR_MS, 250);
  });

  it('distrusts a clock only when it is off by more than the limit whatever the path', () => {
    // 400 off with 100 of round trip is at least 350 off, so the clock is wrong.
    assert.equal(judgeClock([sample('a', 400, 100)]).verdict, CLOCK_UNTRUSTED);
  });

  it('cannot judge an answer whose round trip leaves the clock on either side of the limit', () => {
    // A perfect clock behind a slow path, which a broadcaster's own upload can make.
    const slow = judgeClock([sample('a', 0, 600)]);
    assert.equal(slow.verdict, CLOCK_UNCHECKED);
    assert.equal(slow.estimate?.server, 'a', 'the answer is kept for the report');
    assert.equal(slow.errorBoundMs, 300);
    // Somewhere between 200 and 400 off: neither inside the limit nor surely outside it.
    assert.equal(judgeClock([sample('a', 300, 200)]).verdict, CLOCK_UNCHECKED);
    assert.equal(judgeClock([sample('a', 200, 120)]).verdict, CLOCK_UNCHECKED);
  });

  it('takes the answer with the shortest round trip, whatever the others say', () => {
    const near = judgeClock([sample('far', 400, 90), sample('near', 10, 6), sample('middle', 30, 40)]);
    assert.equal(near.verdict, CLOCK_TRUSTED);
    assert.equal(near.estimate?.server, 'near');

    // And the other way round: a server with a small offset does not win on its offset alone.
    const off = judgeClock([sample('slow', 10, 150), sample('quick', 300, 2)]);
    assert.equal(off.verdict, CLOCK_UNTRUSTED);
    assert.equal(off.estimate?.server, 'quick');
  });

  it('is unchecked when no server answered, which says nothing about the clock', () => {
    const round = judgeClock([]);
    assert.equal(round.verdict, CLOCK_UNCHECKED);
    assert.equal(round.estimate, undefined);
  });
});

describe('the clock check', () => {
  it('is pending and trusted before its first round has finished', () => {
    const { check } = harness();
    assert.equal(check.report().verdict, CLOCK_PENDING);
    assert.equal(check.isTrusted(), true);
  });

  it('asks every server at start and reports the estimate it kept', async () => {
    const { check, asked } = harness({
      'a.time.test': sample('a.time.test', 10, 8),
      'b.time.test': sample('b.time.test', 12, 30),
      'c.time.test': new Error('no answer within 2000 ms'),
    });

    check.start();
    await settle();

    assert.deepEqual(asked, ['a.time.test', 'b.time.test', 'c.time.test']);
    assert.equal(check.isTrusted(), true);
    assert.deepEqual(check.report(), {
      verdict: CLOCK_TRUSTED,
      checkedAt: new Date(WALL_MS).toISOString(),
      server: 'a.time.test',
      offsetMs: 10,
      delayMs: 8,
      errorBoundMs: 14,
      maxErrorMs: CLOCK_MAX_ERROR_MS,
    });
    check.stop();
  });

  it('refuses publishing while untrusted and says so in the log with the offset', async () => {
    const { check, logged } = harness({ 'a.time.test': sample('a.time.test', 300, 4) });

    check.start();
    await settle();

    assert.equal(check.isTrusted(), false);
    assert.equal(check.report().verdict, CLOCK_UNTRUSTED);
    assert.equal(check.report().offsetMs, 300);
    const warning = logged.find((line) => line.level === 'warn');
    assert.ok(warning, 'an untrusted clock is a warning');
    assert.match(warning.message, /300\.0 ms behind a\.time\.test/);
    assert.match(warning.message, /refus/);
    check.stop();
  });

  it('reports a round whose answer came too slowly as unchecked, with that answer and a log line saying why', async () => {
    const { check, logged } = harness({ 'a.time.test': sample('a.time.test', 0, 600) });

    check.start();
    await settle();

    assert.equal(check.isTrusted(), true);
    const report = check.report();
    assert.equal(report.verdict, CLOCK_UNCHECKED);
    assert.equal(report.server, 'a.time.test');
    assert.equal(report.delayMs, 600);
    assert.ok(
      logged.some((line) => line.level === 'warn' && /round trip was too long to judge/.test(line.message)),
      'the warning says the round trip was too long',
    );
    check.stop();
  });

  it('does not refuse publishing when no server answered, and reports it unchecked', async () => {
    const { check, logged } = harness({});

    check.start();
    await settle();

    assert.equal(check.isTrusted(), true);
    const report = check.report();
    assert.equal(report.verdict, CLOCK_UNCHECKED);
    assert.equal(report.checkedAt, new Date(WALL_MS).toISOString());
    assert.equal(report.offsetMs, null);
    assert.equal(report.server, null);
    assert.ok(
      logged.some((line) => line.level === 'warn' && /UDP 123/.test(line.message)),
      'the warning names the port',
    );
    check.stop();
  });

  it('checks again every 10 minutes while trusted', async () => {
    const { check, clock, asked } = harness({ 'a.time.test': sample('a.time.test', 5, 5) });

    check.start();
    await settle();
    assert.equal(asked.length, 3);

    await clock.advance(CLOCK_CHECK_INTERVAL_MS - 1);
    assert.equal(asked.length, 3, 'nothing before the interval');
    await clock.advance(1);
    assert.equal(asked.length, 6, 'a second round at 10 minutes');
    await clock.advance(CLOCK_CHECK_INTERVAL_MS);
    assert.equal(asked.length, 9, 'and a third at 20');
    assert.equal(CLOCK_CHECK_INTERVAL_MS, 600_000);
    check.stop();
  });

  it('checks again every 30 s while untrusted, and goes back to 10 minutes once the clock is fixed', async () => {
    const { check, clock, asked, answer, logged } = harness({ 'a.time.test': sample('a.time.test', 400, 5) });

    check.start();
    await settle();
    assert.equal(check.isTrusted(), false);

    await clock.advance(CLOCK_RETRY_INTERVAL_MS - 1);
    assert.equal(asked.length, 3);
    await clock.advance(1);
    assert.equal(asked.length, 6, 'a retry at 30 s');
    assert.equal(check.isTrusted(), false, 'still off');
    assert.equal(CLOCK_RETRY_INTERVAL_MS, 30_000);

    answer({ 'a.time.test': sample('a.time.test', 3, 5) });
    await clock.advance(CLOCK_RETRY_INTERVAL_MS);
    assert.equal(asked.length, 9);
    assert.equal(check.isTrusted(), true, 'publishing resumes on the round that finds the clock fixed');
    assert.equal(check.report().verdict, CLOCK_TRUSTED);
    assert.ok(logged.some((line) => line.level === 'info' && /resum/.test(line.message)));

    await clock.advance(CLOCK_RETRY_INTERVAL_MS);
    assert.equal(asked.length, 9, 'no retry once trusted');
    await clock.advance(CLOCK_CHECK_INTERVAL_MS - CLOCK_RETRY_INTERVAL_MS);
    assert.equal(asked.length, 12, 'back on the 10 minute interval');
    check.stop();
  });

  for (const [what, inconclusive] of [
    ['no server answers', {}],
    ['the answer comes too slowly to judge', { 'a.time.test': sample('a.time.test', 0, 600) }],
  ] as const) {
    it(`keeps refusing after an untrusted round when ${what}, until a measurement lifts it`, async () => {
      const { check, clock, asked, answer, logged } = harness({ 'a.time.test': sample('a.time.test', 400, 6) });

      check.start();
      await settle();
      assert.equal(check.isTrusted(), false);

      answer(inconclusive);
      await clock.advance(CLOCK_RETRY_INTERVAL_MS);
      assert.equal(asked.length, 6);
      assert.equal(check.isTrusted(), false, 'an inconclusive round does not lift the refusal');
      const report = check.report();
      assert.equal(report.verdict, CLOCK_UNTRUSTED);
      assert.equal(report.offsetMs, 400, "the report keeps the untrusted round's numbers");
      assert.equal(report.delayMs, 6);
      assert.ok(
        logged.some((line) => line.level === 'warn' && /no conclusive answer/.test(line.message) && /refused/.test(line.message)),
        'the log says publishing stays refused',
      );

      await clock.advance(CLOCK_RETRY_INTERVAL_MS);
      assert.equal(asked.length, 9, 'still retrying every 30 s');

      answer({ 'a.time.test': sample('a.time.test', 3, 5) });
      await clock.advance(CLOCK_RETRY_INTERVAL_MS);
      assert.equal(check.isTrusted(), true, 'a trusted round lifts it');
      assert.equal(check.report().verdict, CLOCK_TRUSTED);
      check.stop();
    });
  }

  it('checks again after 30 s when no server answered', async () => {
    const { check, clock, asked, answer } = harness({});

    check.start();
    await settle();
    assert.equal(check.report().verdict, CLOCK_UNCHECKED);

    answer({ 'b.time.test': sample('b.time.test', 1, 1) });
    await clock.advance(CLOCK_RETRY_INTERVAL_MS);
    assert.equal(asked.length, 6);
    assert.equal(check.report().verdict, CLOCK_TRUSTED);
    check.stop();
  });

  it('asks nothing after stop, and a round in flight changes nothing', async () => {
    let release: (value: ClockSample) => void = () => {};
    const clock = new FakeClock();
    const check = new ClockCheck({
      servers: SERVERS.slice(0, 1),
      clock,
      now: () => WALL_MS,
      query: () =>
        new Promise<ClockSample>((resolve) => {
          release = resolve;
        }),
      logger: { info: () => {}, warn: () => {} },
    });

    check.start();
    check.stop();
    release(sample('a.time.test', 400, 1));
    await settle();

    assert.equal(check.report().verdict, CLOCK_PENDING);
    assert.equal(check.isTrusted(), true);
    assert.equal(clock.pendingCount(), 0);
  });

  it('starts once however often start is called', async () => {
    const { check, asked } = harness({ 'a.time.test': sample('a.time.test', 1, 1) });
    check.start();
    check.start();
    await settle();
    assert.equal(asked.length, 3);
    check.stop();
  });
});

describe('the clock check against fake time servers on the loopback', () => {
  async function fakeServer(options: Parameters<typeof startFakeSntpServer>[0]) {
    const server = await startFakeSntpServer(options);
    servers.push(server);
    return server;
  }

  async function oneRound(list: string, queryTimeoutMs = 1_000): Promise<ClockCheck> {
    const check = new ClockCheck({
      servers: parseClockServers(list),
      queryTimeoutMs,
      logger: { info: () => {}, warn: () => {} },
    });
    check.start();
    const deadline = Date.now() + 5_000;
    while (check.report().verdict === CLOCK_PENDING && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    check.stop();
    return check;
  }

  it('trusts a host 10 ms off its servers', async () => {
    const server = await fakeServer({ offsetMs: 10 });
    const check = await oneRound(server.address);
    assert.equal(check.report().verdict, CLOCK_TRUSTED);
    assert.equal(check.isTrusted(), true);
  });

  it('distrusts a host 300 ms off its servers', async () => {
    const server = await fakeServer({ offsetMs: 300 });
    const check = await oneRound(server.address);
    assert.equal(check.report().verdict, CLOCK_UNTRUSTED);
    assert.equal(check.isTrusted(), false);
  });

  it('keeps the quick server over a slow one that disagrees with it', async () => {
    const slow = await fakeServer({ offsetMs: 400, delayMs: 150 });
    const quick = await fakeServer({ offsetMs: 10 });
    const check = await oneRound(`${slow.address},${quick.address}`);
    assert.equal(check.report().server, quick.address);
    assert.equal(check.report().verdict, CLOCK_TRUSTED);
  });

  it('is unchecked when no server answers within the timeout', async () => {
    const silent = await fakeServer({ silent: true });
    const alsoSilent = await fakeServer({ silent: true });
    const check = await oneRound(`${silent.address},${alsoSilent.address}`, 150);
    assert.equal(check.report().verdict, CLOCK_UNCHECKED);
    assert.equal(check.isTrusted(), true);
    assert.equal(silent.requests.length, 1);
    assert.equal(alsoSilent.requests.length, 1);
  });
});
