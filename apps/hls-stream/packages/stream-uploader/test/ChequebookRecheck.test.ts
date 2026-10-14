import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { SINGLE_PUBLISHER } from '../src/libs/BeePublisherPool.js';
import { bzzToPlur, ChequebookGate, ChequebookNode, PLUR_PER_BZZ } from '../src/libs/ChequebookGate.js';
import { ChequebookHealthStore, ChequebookRecheck } from '../src/libs/ChequebookRecheck.js';
import { StartGate } from '../src/libs/StartGates.js';
import {
  HEALTH_DEGRADED,
  HEALTH_OK,
  HEALTH_REASON_CHEQUEBOOK_LOW,
  HEALTH_REASON_START_GATE_WARNED,
  LowChequebook,
  StartGateWarning,
} from '../src/types.js';

import { ApiTestServer, startTestApi } from './helpers/apiTestServer.js';
import { FakeClock } from './helpers/fakeClock.js';
import { makeTestOrchestrator } from './helpers/fakes.js';

const FLOOR_PLUR = bzzToPlur(0.5);
const RECHECK_MS = 60_000;
const CHEQUEBOOK_GATE = 'ChequebookGate';
const POSTAGE_GATE = 'PostageGate';

const servers: ApiTestServer[] = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

/** A chequebook whose available balance a test sets, with every read of it counted. */
interface FakeChequebook {
  availablePlur: bigint;
  /** Set to make the next reads fail the way a read that never reached a node does. */
  failure: Error | null;
  reads: number;
}

function chequebook(availableBzz: number): FakeChequebook {
  return { availablePlur: bzzToPlur(availableBzz), failure: null, reads: 0 };
}

/** The body bee-js hands back, with a total well above the available balance as a live node has. */
function balanceBody(availablePlur: bigint) {
  return {
    totalBalance: { toPLURBigInt: () => availablePlur + 100n * PLUR_PER_BZZ },
    availableBalance: { toPLURBigInt: () => availablePlur },
  };
}

/** A rung's node whose chequebook answers what `book` holds at the moment of each read, and counts the reads. */
function node(url: string, rung: string, book: FakeChequebook): ChequebookNode {
  return {
    url,
    rung,
    bee: {
      chequebook: {
        getBalance: async () => {
          book.reads += 1;
          if (book.failure !== null) {
            throw book.failure;
          }
          return balanceBody(book.availablePlur);
        },
      },
    },
  };
}

/** The chequebook gate as `index.ts` hands it to the boot, over the given nodes. */
function chequebookGate(nodes: readonly ChequebookNode[]): StartGate {
  return {
    name: CHEQUEBOOK_GATE,
    refuses: 'none',
    run: (collect) => new ChequebookGate(nodes, FLOOR_PLUR, { info: () => {} }).assertFunded(collect),
  };
}

/** What `/health` holds, kept the way the orchestrator keeps it: each list replaced whole on every record. */
function healthStore(initial: readonly StartGateWarning[]) {
  let held: readonly StartGateWarning[] = initial;
  let low: readonly LowChequebook[] = [];
  const store: ChequebookHealthStore = {
    getStartGateWarnings: () => held,
    recordStartGateWarnings: (warnings) => {
      held = [...warnings];
    },
    recordLowChequebooks: (nodes) => {
      low = [...nodes];
    },
  };
  return { store, low: () => low };
}

interface LogLine {
  level: 'info' | 'warn' | 'debug';
  message: string;
}

function recordingLogger() {
  const lines: LogLine[] = [];
  return {
    lines,
    info: (message: string) => lines.push({ level: 'info', message }),
    warn: (message: string) => lines.push({ level: 'warn', message }),
    debug: (message: string) => lines.push({ level: 'debug', message }),
  };
}

function linesAt(logger: ReturnType<typeof recordingLogger>, level: LogLine['level']): string[] {
  return logger.lines.filter((line) => line.level === level).map((line) => line.message);
}

/**
 * Lets a read that was just answered finish what it does next. Its continuation is queued behind the
 * answer, so a clock advanced straight away would look for the next timer before it had been set.
 */
function settled(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** What bee-js throws for a request that timed out before any node answered: no status at all. */
function timeout(): Error {
  return new Error('timeout of 20000ms exceeded');
}

interface Setup {
  nodes: readonly ChequebookNode[];
  latched?: readonly StartGateWarning[];
  gate?: StartGate;
}

function recheckOver({ nodes, latched = [], gate = chequebookGate(nodes) }: Setup) {
  const clock = new FakeClock();
  const { store, low } = healthStore(latched);
  const logger = recordingLogger();
  const recheck = new ChequebookRecheck({ gate, intervalMs: RECHECK_MS, store, logger, clock });
  return { clock, store, low, logger, recheck };
}

/**
 * ⛔⛔ **A rung's node ran its chequebook dry during a broadcast and nothing said so.**
 *
 * On 2026-10-01 the 1080p node spent about 5 BZZ in two hours, its chequebook fell under the floor, and
 * the recording lost that rung. The chequebook had been read at boot, where it was funded, and the
 * re-read only ever ran while a boot warning stood. So a node that drained afterwards changed nothing
 * on `/health` and nothing in the log. The chequebook is now read for the life of the process, and a
 * node under the floor is named on `/health` as `chequebook_low` until it holds the floor again. It is
 * a report and nothing more: the broadcast goes on, and nothing here moves money.
 */
describe('every chequebook is read for the life of the process', () => {
  it('starts healthy, names the rung once its chequebook falls under the floor, and clears it once funded', async () => {
    const r360 = chequebook(3);
    const r1080 = chequebook(3);
    const { clock, low, store, recheck } = recheckOver({
      nodes: [node('http://bee-360:1633', '360p', r360), node('http://bee-1080:1633', '1080p', r1080)],
    });

    recheck.start();
    await clock.advance(RECHECK_MS);
    assert.deepEqual(low(), [], 'a funded stage was reported low');

    r1080.availablePlur = bzzToPlur(0.2);
    await clock.advance(RECHECK_MS);
    assert.deepEqual(low(), [{ rung: '1080p' }], 'a drained rung was not named');
    assert.deepEqual(store.getStartGateWarnings(), [], 'a drain after the boot is not a start gate warning');

    r1080.availablePlur = bzzToPlur(2);
    await clock.advance(RECHECK_MS);
    assert.deepEqual(low(), [], 'a funded rung is still reported low');
    assert.equal(clock.pendingCount(), 1, 'it stopped reading, so the next drain would go unseen');
  });

  // Which is also every deployment under `UPLOADER_START_GATES=refuse`, where a chequebook the gate
  // will not accept ends the boot and nothing is ever latched.
  it('reads when the boot left no chequebook warning, one read per node per interval', async () => {
    const book = chequebook(3);
    const { clock, recheck } = recheckOver({
      nodes: [node('http://bee-360:1633', '360p', book)],
      latched: [{ gate: POSTAGE_GATE, rung: '720p' }],
    });

    recheck.start();
    await clock.advance(RECHECK_MS * 3);

    assert.equal(book.reads, 3);
  });

  // A failed read establishes nothing about the balance. Calling it low would repeat the false alarm a
  // timed out chequebook read raised on 2026-09-16, and calling it funded would hide a real drain.
  // A node that stops answering is already reported by the upload path.
  it('does not report a rung low because its read failed', async () => {
    const book = chequebook(3);
    const { clock, low, logger, recheck } = recheckOver({ nodes: [node('http://bee-1080:1633', '1080p', book)] });

    recheck.start();
    book.failure = timeout();
    await clock.advance(RECHECK_MS);

    assert.deepEqual(low(), [], 'a read that never reached the node was reported as a low chequebook');
    assert.ok(
      linesAt(logger, 'warn').some((line) => /bee-1080/.test(line)),
      'the failed read left no line naming the node',
    );
  });

  it('keeps a rung it last read as low named while its reads fail', async () => {
    const book = chequebook(0.2);
    const { clock, low, recheck } = recheckOver({ nodes: [node('http://bee-1080:1633', '1080p', book)] });

    recheck.start();
    await clock.advance(RECHECK_MS);
    assert.deepEqual(low(), [{ rung: '1080p' }]);

    book.failure = timeout();
    await clock.advance(RECHECK_MS);

    assert.deepEqual(low(), [{ rung: '1080p' }], 'a failed read cleared a chequebook last seen under the floor');
  });

  it('warns once when a rung falls under the floor, keeps it at debug after, and says when it recovers', async () => {
    const book = chequebook(3);
    const { clock, logger, recheck } = recheckOver({ nodes: [node('http://bee-1080:1633', '1080p', book)] });

    recheck.start();
    book.availablePlur = bzzToPlur(0.2);
    await clock.advance(RECHECK_MS * 3);

    const warned = linesAt(logger, 'warn');
    assert.equal(warned.length, 1, `expected one warning for the drain: ${JSON.stringify(warned)}`);
    assert.match(warned[0], /bee-1080/, 'the warning does not name the node');

    book.availablePlur = bzzToPlur(2);
    await clock.advance(RECHECK_MS);

    assert.ok(
      linesAt(logger, 'info').some((line) => line.includes('1080p') && line.includes('/health')),
      `no line said the rung left /health: ${JSON.stringify(logger.lines)}`,
    );
  });

  // A single-node deployment routes everything through one publisher whose rung is a placeholder. A
  // report that named the placeholder would put a rung nobody configured on /health.
  it('reports a single-node chequebook with no rung', async () => {
    const book = chequebook(0.2);
    const { clock, low, recheck } = recheckOver({ nodes: [node('http://bee:1633', SINGLE_PUBLISHER, book)] });

    recheck.start();
    await clock.advance(RECHECK_MS);

    assert.deepEqual(low(), [{}]);
  });

  it('waits the whole interval before each read', async () => {
    const book = chequebook(3);
    const { clock, recheck } = recheckOver({ nodes: [node('http://bee-360:1633', '360p', book)] });

    recheck.start();
    await clock.advance(RECHECK_MS - 1);
    assert.equal(book.reads, 0, 'read before the interval was up');
    await clock.advance(1);
    assert.equal(book.reads, 1);
    await clock.advance(RECHECK_MS - 1);
    assert.equal(book.reads, 1, 'the second read did not wait a whole interval after the first');
    await clock.advance(1);

    assert.equal(book.reads, 2);
  });

  // A chequebook read is answered off the chain and may take the whole gate timeout. Reads that
  // overlapped could land out of order, and an older answer landing last would put back a report a
  // newer read had just cleared.
  it('starts the next wait only once the read before it has answered', async () => {
    let reads = 0;
    let answerFirstRead = () => {};
    const slow: ChequebookNode = {
      url: 'http://bee-360:1633',
      rung: '360p',
      bee: {
        chequebook: {
          getBalance: () => {
            reads += 1;
            if (reads > 1) {
              return Promise.resolve(balanceBody(bzzToPlur(0.1)));
            }
            return new Promise((resolve) => {
              answerFirstRead = () => resolve(balanceBody(bzzToPlur(0.1)));
            });
          },
        },
      },
    };
    const { clock, recheck } = recheckOver({ nodes: [slow] });

    recheck.start();
    await clock.advance(RECHECK_MS * 3);
    assert.equal(reads, 1, 'a second read started while the first had not answered');

    answerFirstRead();
    await settled();
    await clock.advance(RECHECK_MS);

    assert.equal(reads, 2);
  });

  it('stops when it is told to', async () => {
    const book = chequebook(3);
    const { clock, recheck } = recheckOver({ nodes: [node('http://bee-360:1633', '360p', book)] });

    recheck.start();
    recheck.stop();
    await clock.advance(RECHECK_MS * 2);

    assert.equal(book.reads, 0);
    assert.equal(clock.pendingCount(), 0);
  });
});

/**
 * ⛔⛔ **An uploader whose chequebook was empty at boot answered 503 until somebody restarted it.**
 *
 * The chequebook gate warns rather than refusing under the shipped `chequebook-warn`, and what it found
 * is latched onto `/health` as `start_gate_warned`. Nothing read the chequebook again after the boot, so
 * funding the node changed nothing an operator could see. An outside tester met exactly that on
 * 2026-09-25 and reported the uploader as stuck. So the boot's warning on a rung goes the moment a read
 * finds that rung holding its floor.
 */
describe("the boot's chequebook warning", () => {
  it('clears on the first read after the node is funded', async () => {
    const book = chequebook(0.1);
    const { clock, store, recheck } = recheckOver({
      nodes: [node('http://bee-360:1633', '360p', book)],
      latched: [{ gate: CHEQUEBOOK_GATE, rung: '360p' }],
    });

    recheck.start();
    await clock.advance(RECHECK_MS);
    assert.deepEqual(store.getStartGateWarnings(), [{ gate: CHEQUEBOOK_GATE, rung: '360p' }]);

    book.availablePlur = bzzToPlur(2);
    await clock.advance(RECHECK_MS);

    assert.deepEqual(store.getStartGateWarnings(), [], 'a funded chequebook is still reported unfunded');
  });

  // The boot's warning already says this rung is short, and a second reason for the same fact would
  // read as two faults.
  it('is the one report for a rung the boot warned about, not chequebook_low as well', async () => {
    const book = chequebook(0.1);
    const { clock, low, recheck } = recheckOver({
      nodes: [node('http://bee-360:1633', '360p', book)],
      latched: [{ gate: CHEQUEBOOK_GATE, rung: '360p' }],
    });

    recheck.start();
    await clock.advance(RECHECK_MS * 2);

    assert.deepEqual(low(), []);
  });

  // The postage gate's findings are about a batch, and a batch it warned about at boot is not
  // something a later read of the chequebook can speak for.
  it('keeps every postage warning while it clears the chequebook ones', async () => {
    const book = chequebook(0.1);
    const { clock, store, recheck } = recheckOver({
      nodes: [node('http://bee-360:1633', '360p', book)],
      latched: [
        { gate: CHEQUEBOOK_GATE, rung: '360p' },
        { gate: POSTAGE_GATE, rung: '720p' },
      ],
    });

    recheck.start();
    book.availablePlur = bzzToPlur(2);
    await clock.advance(RECHECK_MS);

    assert.deepEqual(store.getStartGateWarnings(), [{ gate: POSTAGE_GATE, rung: '720p' }]);
  });

  // A rung funded at boot that drains while another rung's boot warning stands is a drain, reported
  // the way every drain after the boot is.
  it('leaves a rung that drained after the boot to chequebook_low', async () => {
    const low360 = chequebook(0.1);
    const drained = chequebook(3);
    const { clock, store, low, logger, recheck } = recheckOver({
      nodes: [node('http://bee-360:1633', '360p', low360), node('http://bee-720:1633', '720p', drained)],
      latched: [{ gate: CHEQUEBOOK_GATE, rung: '360p' }],
    });

    recheck.start();
    drained.availablePlur = bzzToPlur(0.01);
    await clock.advance(RECHECK_MS);

    assert.deepEqual(store.getStartGateWarnings(), [{ gate: CHEQUEBOOK_GATE, rung: '360p' }]);
    assert.deepEqual(low(), [{ rung: '720p' }]);
    const warned = linesAt(logger, 'warn');
    assert.equal(warned.length, 1, `expected one warning, for the newly drained rung: ${JSON.stringify(warned)}`);
    assert.match(warned[0], /bee-720/);
  });

  // The boot already wrote the whole refusal to the log, and a minute later nothing about it is news.
  it('logs a chequebook that is still short at debug, not as a fresh warning every minute', async () => {
    const book = chequebook(0.1);
    const { clock, logger, recheck } = recheckOver({
      nodes: [node('http://bee-360:1633', '360p', book)],
      latched: [{ gate: CHEQUEBOOK_GATE, rung: '360p' }],
    });

    recheck.start();
    await clock.advance(RECHECK_MS * 3);

    assert.deepEqual(linesAt(logger, 'warn'), [], 'an unchanged finding was warned about again');
    assert.ok(linesAt(logger, 'debug').length > 0, 'three reads left no trace at all');
  });

  it('says in the log when it clears', async () => {
    const book = chequebook(0.1);
    const { clock, logger, recheck } = recheckOver({
      nodes: [node('http://bee-360:1633', '360p', book)],
      latched: [{ gate: CHEQUEBOOK_GATE, rung: '360p' }],
    });

    recheck.start();
    book.availablePlur = bzzToPlur(2);
    await clock.advance(RECHECK_MS);

    const cleared = linesAt(logger, 'info').filter((line) => line.includes(CHEQUEBOOK_GATE) && line.includes('/health'));
    assert.equal(cleared.length, 1, `no line said the warning left /health: ${JSON.stringify(logger.lines)}`);
  });

  it('keeps a single-node warning the way the boot filed it, with no rung', async () => {
    const book = chequebook(0.1);
    const { clock, store, recheck } = recheckOver({
      nodes: [node('http://bee:1633', SINGLE_PUBLISHER, book)],
      latched: [{ gate: CHEQUEBOOK_GATE, rung: undefined }],
    });

    recheck.start();
    await clock.advance(RECHECK_MS);

    assert.deepEqual(store.getStartGateWarnings(), [{ gate: CHEQUEBOOK_GATE, rung: undefined }]);
  });

  // The boot latches a gate that threw rather than collecting, an empty node set for instance, as a
  // warning with no rung. Nothing about that clears by waiting, so it stays, and so does the reading.
  it('keeps a gate that could not be read at all warned, and reads it again', async () => {
    const { clock, store, logger, recheck } = recheckOver({
      nodes: [],
      latched: [{ gate: CHEQUEBOOK_GATE }],
    });

    recheck.start();
    await clock.advance(RECHECK_MS);

    assert.deepEqual(store.getStartGateWarnings(), [{ gate: CHEQUEBOOK_GATE }]);
    assert.equal(clock.pendingCount(), 1, 'it gave up on a gate that may still come good');
    assert.ok(
      logger.lines.some((line) => /no Bee node at all/.test(line.message)),
      'the failure left no trace',
    );
  });
});

describe('/health as the chequebook changes', () => {
  async function servedRecheck(book: FakeChequebook, rung: string) {
    const orchestrator = makeTestOrchestrator();
    const api = await startTestApi(orchestrator);
    servers.push(api);
    const clock = new FakeClock();
    const recheck = new ChequebookRecheck({
      gate: chequebookGate([node(`http://bee-${rung}:1633`, rung, book)]),
      intervalMs: RECHECK_MS,
      store: orchestrator,
      logger: recordingLogger(),
      clock,
    });
    return { orchestrator, api, clock, recheck };
  }

  it('goes back to 200 without a restart once the chequebook the boot warned about is funded', async () => {
    const book = chequebook(0.1);
    const { orchestrator, api, clock, recheck } = await servedRecheck(book, '360p');
    orchestrator.recordStartGateWarnings([{ gate: CHEQUEBOOK_GATE, rung: '360p' }]);

    recheck.start();
    const before = await api.request('/health');
    assert.equal(before.status, 503);
    assert.ok(((before.body as Record<string, unknown>).reasons as string[]).includes(HEALTH_REASON_START_GATE_WARNED));

    book.availablePlur = bzzToPlur(2);
    await clock.advance(RECHECK_MS);
    const { status, body } = await api.request('/health');

    assert.equal(status, 200, `a funded uploader still answers ${status}: ${JSON.stringify(body)}`);
    assert.equal((body as Record<string, unknown>).status, HEALTH_OK);
  });

  it('turns degraded with chequebook_low naming the rung when a node drains mid-broadcast, and recovers', async () => {
    const book = chequebook(3);
    const { api, clock, recheck } = await servedRecheck(book, '1080p');

    recheck.start();
    await clock.advance(RECHECK_MS);
    assert.equal((await api.request('/health')).status, 200);

    book.availablePlur = bzzToPlur(0.2);
    await clock.advance(RECHECK_MS);
    const drained = await api.request('/health');
    const drainedBody = drained.body as Record<string, unknown>;

    assert.equal(drainedBody.status, HEALTH_DEGRADED);
    assert.deepEqual(drainedBody.reasons, [HEALTH_REASON_CHEQUEBOOK_LOW]);
    assert.deepEqual(drainedBody.lowChequebooks, [{ rung: '1080p' }]);
    assert.doesNotMatch(JSON.stringify(drainedBody.lowChequebooks), /bee-1080/, 'the unauthenticated page names a node url');

    book.availablePlur = bzzToPlur(2);
    await clock.advance(RECHECK_MS);
    const recovered = await api.request('/health');

    assert.equal(recovered.status, 200, `a funded node still answers ${recovered.status}: ${JSON.stringify(recovered.body)}`);
    assert.deepEqual((recovered.body as Record<string, unknown>).lowChequebooks, []);
  });
});
