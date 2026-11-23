/**
 * The test stream routes: creating one, its refusals as the console reads them, and its viewer address. Unit test —
 * the real streams router and session gate on a random port, with the stores and the audit log in memory.
 * `pnpm test`.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  NOT_TEST_STREAM_ERROR,
  SESSION_COOKIE_NAME,
  TEST_STREAM_ERROR,
  TEST_STREAM_REFUSALS,
  TEST_STREAMS_PATH,
  testStreamViewerUrlPath,
  viewerUrlProblem,
  type Stream,
  type TestStreamRefusal,
} from '@streaming-monorepo/web2-admin-common';
import express from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createRequireAuth } from '../../src/api/middleware/requireAuth.js';
import { createStreamsRouter } from '../../src/api/routes/streams.js';
import { AuthService } from '../../src/domain/auth/AuthService.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { IngestService } from '../../src/domain/IngestService.js';
import { PublishService } from '../../src/domain/PublishService.js';
import { splitStageRecord } from '../../src/domain/StageService.js';
import { StreamFinishService } from '../../src/domain/StreamFinishService.js';
import { StreamService } from '../../src/domain/StreamService.js';
import type { ExportService } from '../../src/domain/export/ExportService.js';

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
  noCatalogueStamp,
  streamRow,
  TEST_OWNER,
} from './support/fakes.js';
import { FakeStageStore, STAGE_ID, stageRecord } from './support/stageFakes.js';

const PASSWORD = 'a-long-enough-password';

const feed: FeedIdentity = {
  owner: TEST_OWNER,
  topic: 'swarm-stream',
  topicHex: 'cfbbc155d709547b198638d0fb11d733359561538d8bd606a9ab257354d13bcc',
};

const TEST_FORM = { title: 'Sound check', mediaType: 'video', stageId: STAGE_ID };

let server: http.Server;
let url: string;
let audit: InMemoryAuditLog;
let store: FakeStreamStore;
let cookie: string;

before(async () => {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  audit = new InMemoryAuditLog();
  const auth = new AuthService(users, sessions, new InMemoryCredentialRepository(users, sessions), audit);
  await auth.addUser(TEST_SETUP, 'ann', PASSWORD);
  const { token } = await auth.signIn({ username: 'ann', password: PASSWORD, ip: '127.0.0.1', userAgent: null });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;

  const renditions = new FakeRenditionStore();
  store = new FakeStreamStore(renditions);
  const stages = new FakeStageStore();
  await stages.upsert(splitStageRecord(stageRecord()));
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

  const requireAuth = createRequireAuth(auth);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/streams',
    createStreamsRouter({
      streamService: new StreamService(store, stages, feed, audit),
      publishService,
      ingestService: new IngestService(store, stages, audit),
      streamFinishService: new StreamFinishService(store, new IngestService(store, stages, audit), audit, 30),
      exportService: {} as ExportService,
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

async function send(method: string, path: string, body?: unknown, signedIn = true): Promise<Response> {
  return fetch(`${url}${path}`, {
    method,
    headers: {
      ...(signedIn ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createTestStream(): Promise<Stream> {
  const res = await send('POST', TEST_STREAMS_PATH, TEST_FORM);
  assert.equal(res.status, 201);
  return (await res.json()) as Stream;
}

describe('POST /api/streams/test', () => {
  it('creates a test stream with an empty description, answered 201', async () => {
    const created = await createTestStream();

    assert.equal(created.test, true);
    assert.equal(created.status, 'draft');
    assert.equal(created.title, 'Sound check');
    assert.equal(created.description, '');
    assert.deepEqual(created.tags, []);
    assert.equal(created.scheduledStartTime, null);
    assert.equal(created.stageId, STAGE_ID);
    assert.equal(created.viewerUrl, null);
  });

  it('refuses a body without a stage', async () => {
    const res = await send('POST', TEST_STREAMS_PATH, { title: 'Sound check', mediaType: 'video' });

    assert.equal(res.status, 400);
  });

  it('refuses a caller without a session', async () => {
    const res = await send('POST', TEST_STREAMS_PATH, TEST_FORM, false);

    assert.equal(res.status, 401);
  });
});

describe("a test stream's refusals as the console reads them", () => {
  it('answers an edit with 409 test_stream, the action and its sentence', async () => {
    const created = await createTestStream();

    const res = await send('PUT', `/api/streams/${created.id}`, {
      title: 'Renamed',
      description: 'A description.',
      tags: [],
      mediaType: 'video',
      scheduledStartTime: '2026-12-01T09:00:00.000Z',
      stageId: STAGE_ID,
    });

    assert.equal(res.status, 409);
    const body = (await res.json()) as TestStreamRefusal;
    assert.deepEqual(body, {
      error: TEST_STREAM_ERROR,
      id: created.id,
      action: 'edit',
      message: TEST_STREAM_REFUSALS.edit,
    });
  });

  it('answers an image with 409 test_stream, the action and its sentence', async () => {
    const created = await createTestStream();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

    const res = await fetch(`${url}/api/streams/${created.id}/thumbnail`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'image/png' },
      body: png,
    });

    assert.equal(res.status, 409);
    const body = (await res.json()) as TestStreamRefusal;
    assert.equal(body.action, 'thumbnail');
    assert.equal(body.message, TEST_STREAM_REFUSALS.thumbnail);
  });
});

describe('PUT /api/streams/:id/viewer-url', () => {
  it('stores the address as given, answers it on the stream, changes it, and clears it with an empty one', async () => {
    const created = await createTestStream();
    const path = testStreamViewerUrlPath(created.id);

    const set = await send('PUT', path, { url: 'http://203.0.113.7:10004/#/' });
    assert.equal(set.status, 200);
    assert.equal(((await set.json()) as Stream).viewerUrl, 'http://203.0.113.7:10004/#/');
    const read = (await (await send('GET', `/api/streams/${created.id}`)).json()) as Stream;
    assert.equal(read.viewerUrl, 'http://203.0.113.7:10004/#/');

    const changed = await send('PUT', path, { url: 'https://team.example.com/viewer?x=1' });
    assert.equal(((await changed.json()) as Stream).viewerUrl, 'https://team.example.com/viewer?x=1');

    const emptied = await send('PUT', path, { url: '' });
    assert.equal(emptied.status, 200);
    assert.equal(((await emptied.json()) as Stream).viewerUrl, null);
    await send('PUT', path, { url: 'http://203.0.113.7:10004' });
    const nulled = await send('PUT', path, { url: null });
    assert.equal(((await nulled.json()) as Stream).viewerUrl, null);
  });

  it('is taken while the test stream is a draft, live and recorded', async () => {
    for (const status of ['draft', 'live', 'vod'] as const) {
      const test = store.add(streamRow({ test: true, status, description: '' }));
      const res = await send('PUT', testStreamViewerUrlPath(test.id), { url: 'http://203.0.113.7:10004' });
      assert.equal(res.status, 200, status);
      assert.equal(((await res.json()) as Stream).viewerUrl, 'http://203.0.113.7:10004', status);
    }
  });

  it('refuses an address that is no http or https one, with its sentence', async () => {
    const created = await createTestStream();

    for (const bad of ['ftp://203.0.113.7/', '203.0.113.7:10004', 'http://']) {
      const res = await send('PUT', testStreamViewerUrlPath(created.id), { url: bad });
      assert.equal(res.status, 400, bad);
      const body = (await res.json()) as { error: string; errors: string[] };
      assert.equal(body.error, 'validation_error');
      assert.deepEqual(body.errors, [viewerUrlProblem(bad)], bad);
    }
    assert.equal(store.get(created.id).viewer_url, null);
  });

  it('refuses a stream that is no test stream with 409 not_test_stream', async () => {
    const listed = store.add(streamRow());

    const res = await send('PUT', testStreamViewerUrlPath(listed.id), { url: 'http://203.0.113.7:10004' });

    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; id: string };
    assert.equal(body.error, NOT_TEST_STREAM_ERROR);
    assert.equal(body.id, listed.id);
    assert.equal(store.get(listed.id).viewer_url, null);
  });

  it('refuses a caller without a session', async () => {
    const created = await createTestStream();

    const res = await send('PUT', testStreamViewerUrlPath(created.id), { url: 'http://203.0.113.7:10004' }, false);

    assert.equal(res.status, 401);
    assert.equal(store.get(created.id).viewer_url, null);
  });

  it('audits each set as stream.viewer_url.set', async () => {
    const created = await createTestStream();
    audit.entries.length = 0;

    await send('PUT', testStreamViewerUrlPath(created.id), { url: 'http://203.0.113.7:10004' });

    const [entry] = audit.withAction('stream.viewer_url.set');
    assert.equal(entry?.streamId, created.id);
    assert.equal(entry?.actor.kind, 'operator');
  });
});
