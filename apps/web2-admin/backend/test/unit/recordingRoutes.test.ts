/**
 * The routes of the check of the recordings and of the removal of the lost ones, over RecordingCheckService with its
 * stores in memory. `pnpm test`.
 *
 * Pinned here: the check is answered never cached; a start or a removal that is refused answers 409 with the
 * sentence; a removal's body names a check and stream ids, or answers 400; and a removal answers what it did.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import {
  LOST_RECORDINGS_REMOVAL_PATH,
  RECORDING_CHECK_PATH,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  type LostRecordingsRemovalResponse,
  type RecordingCheckResponse,
} from '@streaming-monorepo/web2-admin-common';
import express, { type RequestHandler } from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { createRecordingsRouter, RECORDINGS_PATH } from '../../src/api/routes/recordings.js';
import { NO_CHECK_YET, RecordingCheckService, tooFewPeers } from '../../src/domain/recordings/RecordingCheckService.js';

import { userRow } from './support/authFixtures.js';
import { FakeRenditionStore, FakeStreamStore, InMemoryAuditLog, streamRow, TEST_OPERATOR } from './support/fakes.js';
import { FakeLostRecordingsWrite, FakeRecordingReads, InMemoryRecordingCheckStore } from './support/recordingFakes.js';

const signedIn: RequestHandler = (req, _res, next) => {
  req.user = userRow({ id: TEST_OPERATOR.userId, username: TEST_OPERATOR.username });
  req.sessionTokenHash = 'test-session';
  next();
};

const renditions = new FakeRenditionStore();
const streams = new FakeStreamStore(renditions);
const store = new InMemoryRecordingCheckStore();
const reads = new FakeRecordingReads();
const writer = new FakeLostRecordingsWrite();
const service = new RecordingCheckService(
  {
    store,
    streams,
    renditions,
    jobs: { openJobStreams: async () => new Set(), exportFileStreams: async () => new Set() },
    catalogue: {
      forRead: async () => ({ target: { beeApiUrl: 'http://node.test', batchId: 'c3'.repeat(32) } }),
      status: async () => ({ refusal: null }),
    },
    writer,
    reads,
    audit: new InMemoryAuditLog(),
  },
  { restartWindowMinutes: 30, wait: async () => undefined },
);
let server: http.Server;
let url: string;

before(async () => {
  const app = express();
  app.use(requireSameSite);
  app.use(express.json());
  app.use(RECORDINGS_PATH, createRecordingsRouter({ recordings: service, requireAuth: signedIn }));
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not report a port');
  url = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await service.shutdown();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function post(route: string, body: unknown = {}): Promise<Response> {
  return fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE },
    body: JSON.stringify(body),
  });
}

describe('the recordings routes', () => {
  it('answer that no check has run yet, never cached', async () => {
    const res = await fetch(`${url}${RECORDING_CHECK_PATH}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await res.json()) as RecordingCheckResponse, {
      check: null,
      startRefusal: null,
      removalRefusal: NO_CHECK_YET,
    });
  });

  it('refuse a start with 409 and the sentence while the catalogue node has too few peers', async () => {
    reads.peerCount = 2;
    const res = await post(RECORDING_CHECK_PATH);
    reads.peerCount = 8;
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'recordings_refused', message: tooFewPeers(2, 4) });
  });

  it('refuse a removal whose body names no check or no stream ids, with 400', async () => {
    const res = await post(LOST_RECORDINGS_REMOVAL_PATH, { checkId: 'not-a-uuid', streamIds: 'all' });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'validation_error');
  });

  it('answer what a removal did', async () => {
    const gone = streams.add(streamRow({ status: 'draft', manifest_index: 7, title: 'Gone' }));
    const checkId = randomUUID();
    store.finished(checkId, [{ streamId: gone.id, title: 'Gone', verdict: 'lost' }], new Date());

    const res = await post(LOST_RECORDINGS_REMOVAL_PATH, { checkId, streamIds: [gone.id] });

    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()) as LostRecordingsRemovalResponse, {
      removed: [{ streamId: gone.id, title: 'Gone' }],
      unlisted: [],
      kept: [],
      feedIndex: 41,
    });
    assert.equal(streams.rows.has(gone.id), false);
  });
});
