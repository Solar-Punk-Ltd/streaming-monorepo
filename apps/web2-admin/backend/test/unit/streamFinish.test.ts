/**
 * A finished stream cannot be restarted by mistake: Finish, the restart window's sweep, and the `vod` report's tail,
 * against the in-memory ports. Unit test, no Bee and no database; the SQL's own conditions are pinned in
 * `test/integration/streamFinish.test.ts`. `pnpm test`.
 *
 * The store's database clock (`dbNow`) stands for the `NOW()` the window is worked out against.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IngestDetails } from '@streaming-monorepo/web2-admin-common';

import { toStream, useRestartWindow } from '../../src/api/presenters.js';
import { StreamFinishedError, StreamNotFoundError, StreamNotStartedError } from '../../src/domain/errors/index.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { IngestService } from '../../src/domain/IngestService.js';
import { PublishService } from '../../src/domain/PublishService.js';
import {
  RESTART_WINDOW_ACTOR,
  restartUntilOf,
  startStreamFinishSweep,
  STREAM_RESTART_WINDOW_DEFAULT_MINUTES,
  StreamFinishService,
} from '../../src/domain/StreamFinishService.js';
import { StreamStateService } from '../../src/domain/StreamStateService.js';
import type { StreamRow } from '../../src/types/index.js';

import {
  FakeFeedWriteLog,
  FakeRenditionStore,
  FakeStreamStore,
  InMemoryAuditLog,
  noCatalogueStamp,
  streamRow,
  TEST_OPERATOR,
  TEST_OWNER,
} from './support/fakes.js';
import { ON_STAGE, stagesWithMain } from './support/stageFakes.js';

const feed: FeedIdentity = {
  owner: TEST_OWNER,
  topic: 'swarm-stream',
  topicHex: 'cfbbc155d709547b198638d0fb11d733359561538d8bd606a9ab257354d13bcc',
};

const MINUTE = 60_000;
/** When the fake's `vod` report ends a stream. */
const ENDED = new Date('2026-09-11T11:00:00.000Z');
const OLD_KEY = 'a'.repeat(32);

/** Keys the service hands out, in order, so a test can tell them apart and look for them in the logs. */
function keys(): () => string {
  let n = 0;
  return () => `${String(++n).padStart(2, '0')}${'f'.repeat(30)}`;
}

function setup(windowMinutes = STREAM_RESTART_WINDOW_DEFAULT_MINUTES) {
  const renditions = new FakeRenditionStore();
  const store = new FakeStreamStore(renditions);
  const audit = new InMemoryAuditLog();
  const stages = stagesWithMain();
  const ingest = new IngestService(store, stages, audit);
  const finishing = new StreamFinishService(store, ingest, audit, windowMinutes, keys());
  const publishService = new PublishService(
    store,
    renditions,
    stages,
    new FakeFeedWriteLog(),
    new FakeFeedGateway(),
    noCatalogueStamp(),
    feed,
    audit,
  );
  const state = new StreamStateService(store, publishService, audit, () => finishing.finishEnded());
  return { store, audit, finishing, publishService, state };
}

/** Everything the audit log holds, as text: a key must appear nowhere in it. */
function auditText(audit: InMemoryAuditLog): string {
  return JSON.stringify(audit.entries);
}

describe('Finish', () => {
  it('changes the key of a recorded stream at once, closes its window and names the operator', async () => {
    const { store, audit, finishing } = setup();
    const stream = store.add(streamRow({ status: 'vod', ended_at: ENDED, publish_key: OLD_KEY }));
    store.dbNow = () => new Date(ENDED.getTime() + 5 * MINUTE);

    const { stream: finished, ingest } = await finishing.finish(TEST_OPERATOR, stream.id);

    assert.equal(finished.status, 'vod');
    assert.notEqual(finished.publish_key, OLD_KEY);
    assert.deepEqual(finished.finished_at, store.dbNow());
    assert.equal(ingest.publishKey, finished.publish_key, 'the answer carries the new key for the page');
    assert.equal(restartUntilOf(finished, 30), null, 'a finished stream has no window left');
    const [entry, ...more] = audit.withAction('stream.finish');
    assert.equal(more.length, 0);
    assert.deepEqual(entry?.actor, TEST_OPERATOR);
    assert.equal(entry?.streamId, stream.id);
    assert.deepEqual([entry?.statusBefore, entry?.statusAfter], ['vod', 'vod']);
    assert.equal(auditText(audit).includes(finished.publish_key), false, 'no key in the audit row');
    assert.equal(auditText(audit).includes(OLD_KEY), false);
  });

  it('finishes a live stream, which stays finished through retried live reports and its end', async () => {
    const { store, finishing, publishService, state } = setup();
    const stream = store.add(streamRow({ publish_key: OLD_KEY }));
    await publishService.publish(TEST_OPERATOR, stream.id);
    await state.report(stream.id, { state: 'live' }, ON_STAGE);

    const { stream: finished } = await finishing.finish(TEST_OPERATOR, stream.id);
    assert.equal(finished.status, 'live');
    assert.ok(finished.finished_at);

    // The uploader retries its `live` report; the broadcast goes on, finished.
    await state.report(stream.id, { state: 'live' }, ON_STAGE);
    assert.ok(store.get(stream.id).finished_at, 'a retried live → live leaves it');
    // The encoder stops: the stream ends, finished, with no window to come back in.
    await state.report(stream.id, { state: 'vod', index: 3, duration: 10 }, ON_STAGE);
    await state.idle();
    const ended = store.get(stream.id);
    assert.equal(ended.status, 'vod');
    assert.ok(ended.finished_at, 'the vod report leaves it');
    assert.equal(ended.publish_key, finished.publish_key, 'the sweep changes nothing on a finished stream');
    assert.equal(restartUntilOf(ended, 30), null);
  });

  it('is cleared by a broadcast that comes back on the new key, which starts a new window', async () => {
    const { store, finishing, publishService, state } = setup();
    const stream = store.add(streamRow({ publish_key: OLD_KEY }));
    await publishService.publish(TEST_OPERATOR, stream.id);
    await state.report(stream.id, { state: 'live' }, ON_STAGE);
    // A minute after it ended: well inside the window, so the sweep in the report's tail leaves it to Finish.
    store.dbNow = () => new Date(ENDED.getTime() + MINUTE);
    await state.report(stream.id, { state: 'vod', index: 3, duration: 10 }, ON_STAGE);
    await state.idle();
    await finishing.finish(TEST_OPERATOR, stream.id);

    await state.report(stream.id, { state: 'live' }, ON_STAGE);

    assert.equal(store.get(stream.id).finished_at, null, 'vod → live clears it');
  });

  it('is cleared by a broadcast that starts from published, where a reset left a finished recording', async () => {
    const { store, publishService, state } = setup();
    const stream = store.add(streamRow({ publish_key: OLD_KEY }));
    await publishService.publish(TEST_OPERATOR, stream.id);
    // What the boot's reset leaves of a finished recording whose republish was claimed when the process died.
    store.rows.set(stream.id, { ...store.get(stream.id), status: 'published', finished_at: ENDED });

    await state.report(stream.id, { state: 'live' }, ON_STAGE);

    assert.equal(store.get(stream.id).finished_at, null, 'a live report that starts a broadcast clears it');
  });

  it('refuses a stream that is neither live nor ended, one already finished, and one that does not exist', async () => {
    const { store, audit, finishing } = setup();
    for (const status of ['draft', 'published', 'publishing'] as const) {
      const stream = store.add(streamRow({ status, publish_key: OLD_KEY }));
      await assert.rejects(finishing.finish(TEST_OPERATOR, stream.id), (error: unknown) => {
        assert.ok(error instanceof StreamNotStartedError, status);
        assert.equal(error.message, 'Only a live or ended stream can be finished.');
        return true;
      });
      assert.equal(store.get(stream.id).publish_key, OLD_KEY, `${status}: the key is unchanged`);
    }
    const finished = store.add(streamRow({ status: 'vod', ended_at: ENDED, finished_at: ENDED }));
    await assert.rejects(finishing.finish(TEST_OPERATOR, finished.id), (error: unknown) => {
      assert.ok(error instanceof StreamFinishedError);
      assert.equal(error.message, 'This stream is already finished: its key has changed.');
      return true;
    });
    assert.equal(store.get(finished.id).publish_key, finished.publish_key);
    await assert.rejects(
      finishing.finish(TEST_OPERATOR, '00000000-0000-4000-8000-0000000000ff'),
      (error: unknown) => error instanceof StreamNotFoundError,
    );
    assert.equal(audit.withAction('stream.finish').length, 0, 'a refusal writes no audit row');
  });
});

describe('the restart window', () => {
  it('finishes a recorded stream whose window ran out by the database clock, and leaves the others', async () => {
    const { store, audit, finishing } = setup(30);
    const ranOut = store.add(streamRow({ status: 'vod', ended_at: ENDED, publish_key: OLD_KEY }));
    const recent = store.add(
      streamRow({ status: 'vod', ended_at: new Date(ENDED.getTime() + 2 * MINUTE), publish_key: OLD_KEY }),
    );
    const neverEnded = store.add(streamRow({ status: 'vod', ended_at: null, publish_key: OLD_KEY }));
    const live = store.add(streamRow({ status: 'live', publish_key: OLD_KEY }));
    const draft = store.add(streamRow({ status: 'draft', ended_at: ENDED, publish_key: OLD_KEY }));
    // 31 minutes after the first ended, 29 after the second.
    store.dbNow = () => new Date(ENDED.getTime() + 31 * MINUTE);

    assert.equal(await finishing.finishEnded(), 2);

    assert.notEqual(store.get(ranOut.id).publish_key, OLD_KEY);
    assert.ok(store.get(ranOut.id).finished_at);
    assert.notEqual(store.get(neverEnded.id).publish_key, OLD_KEY, 'a vod with no ended_at counts as ended long ago');
    for (const kept of [recent, live, draft]) {
      assert.equal(store.get(kept.id).publish_key, OLD_KEY);
      assert.equal(store.get(kept.id).finished_at, null);
    }
    const entries = audit.withAction('stream.finish.window');
    assert.deepEqual(entries.map((entry) => entry.streamId).sort(), [ranOut.id, neverEnded.id].sort());
    for (const entry of entries) assert.deepEqual(entry.actor, RESTART_WINDOW_ACTOR);
    assert.equal(auditText(audit).includes(store.get(ranOut.id).publish_key), false, 'no key in the audit rows');
  });

  it('changes each key once, whatever a run is handed twice, and nothing on a second run', async () => {
    const { store, audit } = setup(30);
    const stream = store.add(streamRow({ status: 'vod', ended_at: ENDED, publish_key: OLD_KEY }));
    store.dbNow = () => new Date(ENDED.getTime() + 31 * MINUTE);
    // A store whose selection answers every row twice, as two processes reading at once would see it.
    const twice = Object.assign(Object.create(store) as FakeStreamStore, {
      listRestartWindowRunOut: async (windowMinutes: number) => {
        const ids = await store.listRestartWindowRunOut(windowMinutes);
        return [...ids, ...ids];
      },
    });
    const ingest = { detailsOf: async () => ({}) as IngestDetails };
    const finishing = new StreamFinishService(twice, ingest, audit, 30, keys());

    assert.equal(await finishing.finishEnded(), 1);
    const key = store.get(stream.id).publish_key;
    assert.equal(await finishing.finishEnded(), 0);

    assert.equal(store.get(stream.id).publish_key, key);
    assert.equal(audit.withAction('stream.finish.window').length, 1);
  });

  it('with a window of 0, finishes a stream in the tail of the vod report that ended it', async () => {
    const { store, audit, publishService, state } = setup(0);
    const stream = store.add(streamRow({ publish_key: OLD_KEY }));
    await publishService.publish(TEST_OPERATOR, stream.id);
    await state.report(stream.id, { state: 'live' }, ON_STAGE);
    store.dbNow = () => ENDED;

    await state.report(stream.id, { state: 'vod', index: 3, duration: 10 }, ON_STAGE);
    await state.idle();

    assert.notEqual(store.get(stream.id).publish_key, OLD_KEY);
    assert.ok(store.get(stream.id).finished_at);
    assert.equal(audit.withAction('stream.finish.window').length, 1);
  });

  it("neither fails nor delays the vod report's answer when the sweep in its tail does", async () => {
    const { store, publishService } = setup(0);
    const audit = new InMemoryAuditLog();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let swept = 0;
    const state = new StreamStateService(store, publishService, audit, async () => {
      swept++;
      await held;
      throw new Error('the database went away');
    });
    const stream = store.add(streamRow({ publish_key: OLD_KEY }));
    await publishService.publish(TEST_OPERATOR, stream.id);
    await state.report(stream.id, { state: 'live' }, ON_STAGE);

    const outcome = await state.report(stream.id, { state: 'vod', index: 3, duration: 10 }, ON_STAGE);

    assert.equal(outcome.stream.status, 'vod', 'the report answered while its sweep was still held');
    assert.equal(swept, 1);
    release();
    await state.idle();
    assert.equal(store.get(stream.id).status, 'vod');
  });

  it('runs once at boot, before anything else is started, and never stops the start when that run fails', async () => {
    let runs = 0;
    const sweep = await startStreamFinishSweep(
      {
        finishEnded: async () => {
          runs++;
          throw new Error('the database is not there yet');
        },
      },
      60_000,
    );
    sweep.stop();
    assert.equal(runs, 1, 'the boot run was awaited');
  });
});

describe('restartUntil', () => {
  const vod = (over: Partial<StreamRow> = {}) => streamRow({ status: 'vod', ended_at: ENDED, ...over });

  it('is the end of the stream plus the window, while the stream is recorded and not finished', () => {
    assert.deepEqual(restartUntilOf(vod(), 30), new Date('2026-09-11T11:30:00.000Z'));
    assert.deepEqual(restartUntilOf(vod(), 0), ENDED);
    assert.deepEqual(restartUntilOf(vod(), 10080), new Date('2026-09-18T11:00:00.000Z'));
  });

  it('is null for a finished stream, one with no ended_at, and one that is not recorded', () => {
    assert.equal(restartUntilOf(vod({ finished_at: ENDED }), 30), null);
    assert.equal(restartUntilOf(vod({ ended_at: null }), 30), null);
    for (const status of ['draft', 'published', 'publishing', 'live'] as const) {
      assert.equal(restartUntilOf(vod({ status }), 30), null, status);
    }
  });

  it('reaches the page through the presenter, with the window the process was started with', () => {
    try {
      useRestartWindow(45);
      assert.equal(toStream(vod()).restartUntil, '2026-09-11T11:45:00.000Z');
      assert.equal(toStream(vod({ finished_at: ENDED })).restartUntil, null);
      assert.equal(toStream(vod({ finished_at: ENDED })).finishedAt, ENDED.toISOString());
    } finally {
      useRestartWindow(STREAM_RESTART_WINDOW_DEFAULT_MINUTES);
    }
  });
});
