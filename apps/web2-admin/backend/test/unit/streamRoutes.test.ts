/**
 * The stream routes name the signed-in operator as the actor. Unit test — the
 * real streams router and session gate on a random port, with the stores and
 * the audit log in memory. `pnpm test`.
 *
 * The services cannot check this themselves: they record whoever they are
 * handed. What is pinned here is that the route hands them the user of the
 * session the request came with, and nobody else — not whoever drafted the
 * stream, and not a name the request body could carry. And that a publish or
 * unpublish of a stream that does not exist still answers 404.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { SESSION_COOKIE_NAME, type Stream } from '@streaming-monorepo/web2-admin-common';
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
};

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
  const publishService = new PublishService(
    store,
    renditions,
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
      streamService: new StreamService(store, feed, audit),
      publishService,
      ingestService: new IngestService(
        store,
        {
          host: 'ingest.example.com',
          srtPort: 10061,
          rtmpPort: 10062,
          rtmpPublic: false,
          srtPassphrase: null,
          keyVerified: true,
        },
        audit,
      ),
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
