/**
 * The stream routes name the signed-in operator as the actor. Unit test — the
 * real streams router and session gate on a random port, with the stores and
 * the audit log in memory. `pnpm test`.
 *
 * The services cannot check this themselves: they record whoever they are
 * handed. What is pinned here is that the route hands them the user of the
 * session the request came with, and nobody else — not whoever drafted the
 * stream, and not a name the request body could carry. And that a publish or
 * unpublish of a stream that does not exist still answers 404. And that the
 * stage rules reach the console as their own 409s, with a sentence each.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { SESSION_COOKIE_NAME, type IngestDetails, type Stream } from '@streaming-monorepo/web2-admin-common';
import express from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createRequireAuth } from '../../src/api/middleware/requireAuth.js';
import { createFeedRouter } from '../../src/api/routes/feed.js';
import { createStreamsRouter } from '../../src/api/routes/streams.js';
import { AuthService } from '../../src/domain/auth/AuthService.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { IngestService } from '../../src/domain/IngestService.js';
import { PublishService } from '../../src/domain/PublishService.js';
import { splitStageRecord } from '../../src/domain/StageService.js';
import { StreamService } from '../../src/domain/StreamService.js';

import {
  InMemoryCredentialRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  TEST_SETUP,
} from './support/authFixtures.js';
import {
  FakeFeedWriteLog,
  FakeRenditionStore,
  FakeStreamStore,
  InMemoryAuditLog,
  TEST_OWNER,
} from './support/fakes.js';
import { FakeStageStore, STAGE_ID, stageRecord } from './support/stageFakes.js';

const PASSWORD = 'a-long-enough-password';

/** A stream id no row has, well-formed so the route's UUID check lets it through. */
const UNKNOWN_STREAM = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const feed: FeedIdentity = {
  owner: TEST_OWNER,
  topic: 'swarm-stream',
  topicHex: 'cfbbc155d709547b198638d0fb11d733359561538d8bd606a9ab257354d13bcc',
};

const FORM = {
  title: 'Opening keynote',
  description: 'The opening talk.',
  tags: ['swarm'],
  mediaType: 'video',
  scheduledStartTime: '2026-10-01T09:00:00.000Z',
  stageId: STAGE_ID,
};

/** A stage the manager retired, and one on an engine the admin takes no streams on. */
const RETIRED_STAGE = '6a1d3b9f-2c3d-4e4f-9a51-1b2c3d4e5f60';
const OME_STAGE = '7b2e4c0a-3d4e-4f50-8b62-2c3d4e5f6071';

let server: http.Server;
let url: string;
let audit: InMemoryAuditLog;
let store: FakeStreamStore;
const cookies = new Map<string, string>();
const userIds = new Map<string, string>();

before(async () => {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  audit = new InMemoryAuditLog();
  const auth = new AuthService(users, sessions, new InMemoryCredentialRepository(users, sessions), audit);
  for (const username of ['ann', 'bob']) {
    userIds.set(username, (await auth.addUser(TEST_SETUP, username, PASSWORD)).id);
    const { token } = await auth.signIn({ username, password: PASSWORD, ip: '127.0.0.1', userAgent: null });
    cookies.set(username, `${SESSION_COOKIE_NAME}=${token}`);
  }

  const renditions = new FakeRenditionStore();
  store = new FakeStreamStore(renditions);
  const stages = new FakeStageStore();
  await stages.upsert(splitStageRecord(stageRecord()));
  await stages.upsert(splitStageRecord(stageRecord({ stageId: RETIRED_STAGE, name: 'Old stage' })));
  await stages.retire(RETIRED_STAGE, '2026-09-28T11:00:00.000Z');
  await stages.upsert(splitStageRecord(stageRecord({ stageId: OME_STAGE, name: 'OME stage', engine: 'ome' })));
  const publishService = new PublishService(
    store,
    renditions,
    stages,
    new FakeFeedWriteLog(),
    new FakeFeedGateway(),
    feed,
    audit,
  );

  const requireAuth = createRequireAuth(auth);
  const app = express();
  app.use(express.json());
  app.use('/api/feed', createFeedRouter({ publishService, requireAuth }));
  app.use(
    '/api/streams',
    createStreamsRouter({
      streamService: new StreamService(store, stages, feed, audit),
      publishService,
      ingestService: new IngestService(store, stages, audit),
      requireAuth,
    }),
  );
  app.use(errorHandler);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not report a port');
  url = `http://127.0.0.1:${address.port}`;
});

after(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
);

async function send(as: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${url}${path}`, {
    method,
    headers: {
      cookie: cookies.get(as)!,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('the stream routes', () => {
  it('pass the signed-in user as the actor of POST /api/streams, and as the drafter on the row', async () => {
    audit.entries.length = 0;

    const res = await send('ann', 'POST', '/api/streams', FORM);

    assert.equal(res.status, 201);
    const created = (await res.json()) as Stream;
    assert.equal(store.get(created.id).user_id, userIds.get('ann'));
    assert.deepEqual(
      audit.entries.map(({ actor, action, streamId }) => ({ actor, action, streamId })),
      [
        {
          actor: { kind: 'operator', userId: userIds.get('ann'), username: 'ann' },
          action: 'stream.create',
          streamId: created.id,
        },
      ],
    );
  });

  it('name whoever acts, not whoever drafted the stream', async () => {
    // A stream belongs to the installation: bob can publish ann's draft, and
    // the entry says it was bob.
    const created = (await (await send('ann', 'POST', '/api/streams', FORM)).json()) as Stream;
    audit.entries.length = 0;

    const res = await send('bob', 'POST', `/api/streams/${created.id}/publish`);

    assert.equal(res.status, 200);
    const [entry] = audit.withAction('stream.publish');
    assert.deepEqual(entry?.actor, { kind: 'operator', userId: userIds.get('bob'), username: 'bob' });
    assert.equal(store.get(created.id).user_id, userIds.get('ann'), 'the drafter is still recorded');
  });

  it('pass the signed-in user as the actor of POST /api/feed/reconcile', async () => {
    // A published row with no entry behind it, so the reconcile has
    // something to write and therefore something to record.
    const created = (await (await send('ann', 'POST', '/api/streams', FORM)).json()) as Stream;
    store.add({ ...store.get(created.id), status: 'published', published_feed_index: 0 });
    audit.entries.length = 0;

    const res = await send('bob', 'POST', '/api/feed/reconcile');

    assert.equal(res.status, 200);
    const [entry] = audit.withAction('feed.reconcile');
    assert.deepEqual(entry?.actor, { kind: 'operator', userId: userIds.get('bob'), username: 'bob' });
  });

  it('answer 404 stream_not_found to a publish or an unpublish of a stream that does not exist', async () => {
    for (const path of [`/api/streams/${UNKNOWN_STREAM}/publish`, `/api/streams/${UNKNOWN_STREAM}/unpublish`]) {
      const res = await send('ann', 'POST', path);

      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { error: 'stream_not_found', id: UNKNOWN_STREAM }, path);
    }
  });
});

describe('the stream routes, on stages', () => {
  it('create a stream on the stage the form names, and answer it', async () => {
    const res = await send('ann', 'POST', '/api/streams', { ...FORM, stageId: STAGE_ID.toUpperCase() });

    assert.equal(res.status, 201);
    const created = (await res.json()) as Stream;
    assert.equal(created.stageId, STAGE_ID, 'kept in lower case');
    assert.equal(store.get(created.id).stage_id, STAGE_ID);
  });

  it('create a stream with no stage when the form names none', async () => {
    const res = await send('ann', 'POST', '/api/streams', { ...FORM, stageId: null });

    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as Stream).stageId, null);
  });

  it('refuse a retired, an unsupported or an unknown stage with 409 stage_unavailable', async () => {
    const unknown = 'ffffffff-ffff-4fff-8fff-fffffffffff0';
    for (const [stageId, reason] of [
      [RETIRED_STAGE, 'retired'],
      [OME_STAGE, 'unsupported'],
      [unknown, 'unknown'],
    ] as const) {
      const res = await send('ann', 'POST', '/api/streams', { ...FORM, stageId });

      assert.equal(res.status, 409, reason);
      const body = (await res.json()) as { error: string; stageId: string; reason: string; message: string };
      assert.equal(body.error, 'stage_unavailable', reason);
      assert.equal(body.stageId, stageId, reason);
      assert.equal(body.reason, reason);
      assert.ok(body.message.length > 0, reason);
    }
  });

  it('refuse a stageId that is not a UUID with a validation error', async () => {
    const res = await send('ann', 'POST', '/api/streams', { ...FORM, stageId: 'main-stage' });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'validation_error', errors: ['stageId must be a UUID'] });
  });

  it('refuse to move a published stream to another stage with 409 stage_locked', async () => {
    const created = (await (await send('ann', 'POST', '/api/streams', { ...FORM, stageId: null })).json()) as Stream;
    store.add({ ...store.get(created.id), status: 'published', published_feed_index: 3 });

    const res = await send('ann', 'PUT', `/api/streams/${created.id}`, { ...FORM, stageId: STAGE_ID });

    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      error: 'stage_locked',
      id: created.id,
      reason: 'published',
      message: 'Unpublish the stream to change its stage; publishing fixed it.',
    });
  });

  it('refuse to publish a draft with no stage with 409 stage_required', async () => {
    const created = (await (await send('ann', 'POST', '/api/streams', { ...FORM, stageId: null })).json()) as Stream;

    const res = await send('ann', 'POST', `/api/streams/${created.id}/publish`);

    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      error: 'stage_required',
      id: created.id,
      message: 'Pick the stage this stream is broadcast on before publishing.',
    });
    assert.equal(store.get(created.id).status, 'draft');
  });

  it('answer the ingest details of a stream from its stage, and none without one', async () => {
    const onStage = (await (await send('ann', 'POST', '/api/streams', FORM)).json()) as Stream;
    const without = (await (await send('ann', 'POST', '/api/streams', { ...FORM, stageId: null })).json()) as Stream;

    const details = (await (await send('ann', 'GET', `/api/streams/${onStage.id}/ingest`)).json()) as IngestDetails;
    const none = (await (await send('ann', 'GET', `/api/streams/${without.id}/ingest`)).json()) as IngestDetails;

    assert.equal(details.stage?.name, 'Main stage');
    assert.ok(details.srt?.url.startsWith('srt://ingest.example.org:10061?'));
    assert.equal(none.stage, null);
    assert.equal(none.srt, null);
    assert.equal(none.publishKey.length, 32);
  });
});
