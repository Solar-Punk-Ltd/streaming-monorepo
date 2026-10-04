/**
 * A ladder source SRS accepted, whose transcoders never publish a rung.
 *
 * Seen once on a test deployment: an RTMP broadcaster started on a slow link, every ladder encoder hung at
 * its banner and stayed there after the link recovered, and nothing said so. The source's own publish
 * starts no stream, so no reaper, no stall and no health reason could see a broadcast that never began.
 * These cases drive the real SRS router and a real orchestrator on a fake clock.
 */

import express from 'express';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSrsEngine } from '../src/engines/srs.js';
import { SRS_WEBHOOK_TOKEN_PARAM } from '../src/engines/srs/webhookToken.js';
import { AbrLadder, DEFAULT_LADDER_SPEC } from '../src/libs/AbrLadder.js';
import { Logger } from '../src/libs/Logger.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { LogLevel } from '../src/libs/logLevels.js';
import { deriveHealthStatus } from '../src/utils/health.js';
import { derivePublishKey, PUBLISH_KEY_PARAM } from '../src/utils/publishKey.js';

import { FakeClock } from './helpers/fakeClock.js';
import { makeTestOrchestrator } from './helpers/fakes.js';
import { listenOnLoopback } from './helpers/loopbackServer.js';

const APP = 'video';
const STREAM = '5f0c7b9e-3a1d-4e8f-9b2c-6d4a1e7f0c3b';
const STREAM_ID = `${APP}/${STREAM}`;
const ABR_VHOST = 'abr';
const RUNG = '720p';

const SRS_TOKEN = 'srs-webhook-token-0123456789abcdef';
const PUBLISH_SECRET = 'publish-key-secret-0123456789abcdef';
const KEY = derivePublishKey(PUBLISH_SECRET, STREAM_ID);

const FIRST_RUNG_DEADLINE_MS = 45_000;
const SEGMENT_STALL_MS = 30_000;
const LADDER_NOT_STARTED = 'ladder_not_started';

type SrsHookBody = Record<string, string>;

function sourceHook(action: string, clientId = 'p26w1s45'): SrsHookBody {
  return {
    action,
    client_id: clientId,
    ip: '203.0.113.10',
    vhost: '__defaultVhost__',
    app: APP,
    stream: STREAM,
    param: `?${PUBLISH_KEY_PARAM}=${KEY}`,
  };
}

const OTHER_STREAM = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const OTHER_STREAM_ID = `${APP}/${OTHER_STREAM}`;

function otherSourceHook(action: string): SrsHookBody {
  return {
    ...sourceHook(action, 'q81x4t07'),
    stream: OTHER_STREAM,
    param: `?${PUBLISH_KEY_PARAM}=${derivePublishKey(PUBLISH_SECRET, OTHER_STREAM_ID)}`,
  };
}

function rungHook(action: string): SrsHookBody {
  return {
    action,
    client_id: 'k7r2m9q4',
    ip: '127.0.0.1',
    vhost: ABR_VHOST,
    app: APP,
    stream: `${STREAM}_${RUNG}`,
    param: `?vhost=${ABR_VHOST}`,
  };
}

interface Stage {
  send: (body: SrsHookBody) => Promise<number>;
  clock: FakeClock;
  orchestrator: StreamOrchestrator;
  errors: string[];
}

/** A ladder engine in front of a real orchestrator, with every error line it logs collected. */
async function onStage(drive: (stage: Stage) => Promise<void>): Promise<void> {
  const clock = new FakeClock();
  const ladder = AbrLadder.parse(DEFAULT_LADDER_SPEC);
  const orchestrator = makeTestOrchestrator({
    clock,
    ladder,
    segmentStallMs: SEGMENT_STALL_MS,
    firstRungDeadlineMs: FIRST_RUNG_DEADLINE_MS,
  });
  const engine = createSrsEngine('/srv/media', {
    webhookToken: SRS_TOKEN,
    publishKeySecret: PUBLISH_SECRET,
    abr: { vhost: ABR_VHOST, ladder },
  });
  const app = express();
  app.use(express.json());
  app.use(engine.prefix, engine.createRouter(orchestrator));
  const { server, baseUrl } = await listenOnLoopback(app);

  const errors: string[] = [];
  const logger = Logger.getInstance();
  const previous = logger.configure({
    sink: (level: LogLevel, line: string) => {
      if (level === 'error') {
        errors.push(line);
      }
    },
  });

  const send = async (body: SrsHookBody): Promise<number> => {
    const response = await fetch(`${baseUrl}${engine.prefix}/streams?${SRS_WEBHOOK_TOKEN_PARAM}=${SRS_TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await response.json()) as number;
  };

  try {
    await drive({ send, clock, orchestrator, errors });
  } finally {
    logger.configure(previous);
    server.close();
    await orchestrator.cleanup();
  }
}

const reasonsOf = (orchestrator: StreamOrchestrator): string[] =>
  deriveHealthStatus(orchestrator.getHealthSignals(), SEGMENT_STALL_MS).reasons;

const linesAboutNoRung = (errors: string[]): string[] => errors.filter((line) => line.includes('no rung'));

describe('a ladder source whose transcoders never publish a rung', () => {
  it('is reported once, by name, in the log and on /health, when the deadline passes', async () => {
    await onStage(async ({ send, clock, orchestrator, errors }) => {
      assert.equal(await send(sourceHook('on_publish')), 0);

      await clock.advance(FIRST_RUNG_DEADLINE_MS - 1);
      assert.deepEqual(linesAboutNoRung(errors), [], 'nothing is said before the deadline');
      assert.ok(!reasonsOf(orchestrator).includes(LADDER_NOT_STARTED));

      await clock.advance(1);
      const said = linesAboutNoRung(errors);
      assert.equal(said.length, 1, `one error line when the deadline passes, got ${JSON.stringify(errors)}`);
      assert.ok(said[0]?.includes(STREAM_ID), 'the line names the stream');
      assert.ok(!said[0]?.includes(KEY), 'and never the key it published with');
      assert.ok(reasonsOf(orchestrator).includes(LADDER_NOT_STARTED), '/health says so with its own reason');
      assert.deepEqual(orchestrator.getHealthSignals().ladderNotStartedStreams, [STREAM_ID]);

      await clock.advance(FIRST_RUNG_DEADLINE_MS * 4);
      assert.equal(linesAboutNoRung(errors).length, 1, 'and it fires once, not once per deadline');
    });
  });

  it('clears the reason when the broadcaster leaves, so its reconnect starts clean', async () => {
    await onStage(async ({ send, clock, orchestrator }) => {
      assert.equal(await send(sourceHook('on_publish')), 0);
      await clock.advance(FIRST_RUNG_DEADLINE_MS);
      assert.ok(reasonsOf(orchestrator).includes(LADDER_NOT_STARTED));

      assert.equal(await send(sourceHook('on_unpublish')), 0);
      assert.ok(!reasonsOf(orchestrator).includes(LADDER_NOT_STARTED));
    });
  });

  it('clears the reason when a rung publishes at last', async () => {
    await onStage(async ({ send, clock, orchestrator }) => {
      assert.equal(await send(sourceHook('on_publish')), 0);
      await clock.advance(FIRST_RUNG_DEADLINE_MS);
      assert.ok(reasonsOf(orchestrator).includes(LADDER_NOT_STARTED));

      assert.equal(await send(rungHook('on_publish')), 0);
      assert.ok(!reasonsOf(orchestrator).includes(LADDER_NOT_STARTED));
    });
  });
});

describe('a ladder source whose first rung follows in time', () => {
  it('fires nothing', async () => {
    await onStage(async ({ send, clock, orchestrator, errors }) => {
      assert.equal(await send(sourceHook('on_publish')), 0);
      await clock.advance(10_000);
      assert.equal(await send(rungHook('on_publish')), 0);

      await clock.advance(FIRST_RUNG_DEADLINE_MS * 2);
      assert.deepEqual(linesAboutNoRung(errors), []);
      assert.ok(!reasonsOf(orchestrator).includes(LADDER_NOT_STARTED));
      assert.deepEqual(orchestrator.getHealthSignals().ladderNotStartedStreams, []);
    });
  });

  it('fires nothing for a source that leaves before the deadline', async () => {
    await onStage(async ({ send, clock, orchestrator, errors }) => {
      assert.equal(await send(sourceHook('on_publish')), 0);
      await clock.advance(10_000);
      assert.equal(await send(sourceHook('on_unpublish')), 0);

      await clock.advance(FIRST_RUNG_DEADLINE_MS * 2);
      assert.deepEqual(linesAboutNoRung(errors), []);
      assert.ok(!reasonsOf(orchestrator).includes(LADDER_NOT_STARTED));
    });
  });
});

describe('a ladder source that comes back while SRS still holds its rungs', () => {
  it('fires nothing when it returns inside the encoder hold, since the held rung is live', async () => {
    await onStage(async ({ send, clock, orchestrator, errors }) => {
      assert.equal(await send(sourceHook('on_publish')), 0);
      assert.equal(await send(rungHook('on_publish')), 0);
      assert.equal(await send(sourceHook('on_unpublish')), 0);
      await clock.advance(5_000);
      assert.equal(await send(sourceHook('on_publish', 'b3c9d1e5')), 0);

      await clock.advance(FIRST_RUNG_DEADLINE_MS * 2);
      assert.deepEqual(linesAboutNoRung(errors), []);
      assert.ok(!reasonsOf(orchestrator).includes(LADDER_NOT_STARTED));
      assert.deepEqual(orchestrator.getHealthSignals().ladderNotStartedStreams, []);
    });
  });
});

describe('a ladder source published a second time before any rung', () => {
  it('keeps the original deadline, which fires once at 45 s', async () => {
    await onStage(async ({ send, clock, orchestrator, errors }) => {
      assert.equal(await send(sourceHook('on_publish')), 0);
      await clock.advance(30_000);
      assert.equal(await send(sourceHook('on_publish', 'b3c9d1e5')), 0);

      await clock.advance(FIRST_RUNG_DEADLINE_MS - 30_000 - 1);
      assert.deepEqual(linesAboutNoRung(errors), [], 'the takeover did not move the deadline, nothing yet');

      await clock.advance(1);
      assert.equal(linesAboutNoRung(errors).length, 1, 'it fires 45 s after the first publish');
      assert.deepEqual(orchestrator.getHealthSignals().ladderNotStartedStreams, [STREAM_ID]);

      await clock.advance(FIRST_RUNG_DEADLINE_MS * 4);
      assert.equal(linesAboutNoRung(errors).length, 1, 'and only once');
    });
  });
});

describe('two ladder sources waiting at once', () => {
  it('keeps the other armed and firing when one is cleared', async () => {
    await onStage(async ({ send, clock, orchestrator, errors }) => {
      assert.equal(await send(sourceHook('on_publish')), 0);
      assert.equal(await send(otherSourceHook('on_publish')), 0);
      await clock.advance(10_000);
      assert.equal(await send(sourceHook('on_unpublish')), 0);

      await clock.advance(FIRST_RUNG_DEADLINE_MS - 10_000);
      const said = linesAboutNoRung(errors);
      assert.equal(said.length, 1, `only the source still waiting is reported, got ${JSON.stringify(errors)}`);
      assert.ok(said[0]?.includes(OTHER_STREAM_ID));
      assert.ok(!said[0]?.includes(STREAM_ID));
      assert.deepEqual(orchestrator.getHealthSignals().ladderNotStartedStreams, [OTHER_STREAM_ID]);
    });
  });
});
