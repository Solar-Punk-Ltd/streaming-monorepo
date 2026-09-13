/**
 * The internal API against the RUNNING backend: what the swarm-hls-stream
 * uploader does when an encoder connects, and what it reports afterwards.
 *
 * Prerequisites (from web2-admin/backend/), on a port of your own so this
 * never reports state through an instance pointed at a real Bee node:
 *
 *   pnpm database:start
 *   WEB2_ADMIN_PORT=9879 FEED_GATEWAY=fake \
 *     INTERNAL_API_TOKEN=web2-admin-integration-internal-token-000000 pnpm dev
 *   WEB2_ADMIN_URL=http://localhost:9879 pnpm test:integration
 *
 * The catalogue entry is read back from `feed_writes`, the log of what the
 * backend believes it wrote: the assertion that matters here is not that the
 * row flipped to `live` but that the entry a viewer reads did, and the HTTP
 * response cannot show that.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  FeedStreamEntry,
  IngestLookupResponse,
  PublishResult,
  Stream,
  StreamStateResponse,
} from '@streaming-monorepo/web2-admin-common';
import pg from 'pg';

import {
  api,
  internalCall,
  login,
  raw,
  requireStack,
  type RawResponse,
} from './helpers.js';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://web2admin:web2admin@127.0.0.1:5433/web2admin';

const draft = {
  title: 'itest internal',
  description: 'Created by the web2-admin internal API suite.',
  tags: ['itest'],
  mediaType: 'video' as const,
  scheduledStartTime: '2026-10-01T09:00:00.000Z',
};

const created = new Set<string>();
let pool: pg.Pool;

before(async () => {
  await requireStack();
  await login();
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
});

after(async () => {
  await login();
  for (const id of created) {
    // A live stream refuses both, which is the point of one of the tests
    // below; end it first so the row can be cleaned up like any other.
    const stream = await raw('GET', `/api/streams/${id}`);
    if ((stream.body as Stream | undefined)?.status === 'live') {
      await reportState(id, { state: 'vod', index: 0, duration: 1 });
    }
    await raw('POST', `/api/streams/${id}/unpublish`);
    await raw('DELETE', `/api/streams/${id}`);
  }
  await pool?.end();
});

async function publishedStream(
  overrides: Partial<typeof draft> = {},
): Promise<Stream> {
  const stream = await api<Stream>('POST', '/api/streams', {
    body: { ...draft, ...overrides },
  });
  created.add(stream.id);
  const result = await api<PublishResult>(
    'POST',
    `/api/streams/${stream.id}/publish`,
  );
  return result.stream;
}

function reportState(id: string, body: unknown): Promise<RawResponse> {
  return raw('POST', `/api/internal/streams/${id}/state`, {
    ...internalCall(),
    body,
  });
}

/** The entry for this topic in the newest feed write that contains it. */
async function catalogueEntry(topic: string): Promise<FeedStreamEntry> {
  const result = await pool.query<{ payload: unknown[] }>(
    `SELECT payload FROM feed_writes
      WHERE payload @> $1::jsonb
      ORDER BY id DESC
      LIMIT 1`,
    [JSON.stringify([{ topic }])],
  );
  const payload = result.rows[0]?.payload;
  assert.ok(payload, `no feed write contains topic ${topic}`);
  const entry = payload.find(
    (e) => (e as FeedStreamEntry | null)?.topic === topic,
  );
  assert.ok(entry, `topic ${topic} not in the payload`);
  return entry as FeedStreamEntry;
}

describe('internal API authentication', () => {
  it('refuses every internal route without the token', async () => {
    const id = '1867808f-7b1c-4e46-b437-f7423b466b39';
    const calls: [string, string][] = [
      ['GET', `/api/internal/streams/by-ingest/video/${id}`],
      ['POST', `/api/internal/streams/${id}/state`],
    ];
    for (const [method, path] of calls) {
      const anonymous = await raw(method, path, { anonymous: true });
      assert.equal(anonymous.status, 401, `${method} ${path}`);
      assert.deepEqual(anonymous.body, { error: 'unauthenticated' });

      const wrong = await raw(method, path, {
        ...internalCall('not-the-token-but-long-enough-to-look-like-one'),
      });
      assert.equal(wrong.status, 401, `${method} ${path} with a wrong token`);
    }
  });

  it('does not accept a console session cookie instead', async () => {
    // The two authentications are mounted on disjoint paths on purpose: a
    // logged-in operator is not the uploader.
    const response = await raw(
      'GET',
      '/api/internal/streams/by-ingest/video/1867808f-7b1c-4e46-b437-f7423b466b39',
    );
    assert.equal(response.status, 401);
  });
});

describe('internal lookup by ingest stream id', () => {
  let stream: Stream;

  before(async () => {
    stream = await publishedStream();
  });

  it('resolves a published stream, with the key the encoder must present', async () => {
    const found = await api<IngestLookupResponse>(
      'GET',
      `/api/internal/streams/by-ingest/video/${stream.topic}`,
      internalCall(),
    );

    assert.equal(found.id, stream.id);
    assert.equal(found.topic, stream.topic);
    assert.equal(found.owner, stream.owner);
    assert.equal(found.mediaType, 'video');
    assert.equal(found.title, stream.title);
    assert.equal(found.status, 'published');
    assert.match(found.publishKey, /^[0-9a-f]{32}$/);
  });

  it('refuses a draft: nobody has been told it exists', async () => {
    const unpublished = await api<Stream>('POST', '/api/streams', {
      body: draft,
    });
    created.add(unpublished.id);

    const response = await raw(
      'GET',
      `/api/internal/streams/by-ingest/video/${unpublished.topic}`,
      internalCall(),
    );
    assert.equal(response.status, 404);
    assert.equal((response.body as { error: string }).error, 'stream_not_found');
  });

  it('refuses the right topic under the wrong app', async () => {
    // `<mediaType>/<topic>` is the whole ingest address; half of it matching
    // is not a match.
    const response = await raw(
      'GET',
      `/api/internal/streams/by-ingest/audio/${stream.topic}`,
      internalCall(),
    );
    assert.equal(response.status, 404);
    assert.equal((response.body as { error: string }).error, 'stream_not_found');
  });

  it('404s an unknown topic and 400s a malformed one', async () => {
    const unknown = await raw(
      'GET',
      '/api/internal/streams/by-ingest/video/1867808f-7b1c-4e46-b437-f7423b466b39',
      internalCall(),
    );
    assert.equal(unknown.status, 404);

    const malformed = await raw(
      'GET',
      '/api/internal/streams/by-ingest/video/not-a-uuid',
      internalCall(),
    );
    assert.equal(malformed.status, 400);
    assert.equal(
      (malformed.body as { error: string }).error,
      'validation_error',
    );
  });
});

describe('internal state reports', () => {
  let stream: Stream;

  before(async () => {
    stream = await publishedStream({ title: 'itest internal live' });
  });

  it('refuses a live report for a stream that was never published', async () => {
    const unpublished = await api<Stream>('POST', '/api/streams', {
      body: draft,
    });
    created.add(unpublished.id);

    const response = await reportState(unpublished.id, { state: 'live' });
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      error: 'invalid_state_transition',
      from: 'draft',
      to: 'live',
    });
  });

  it('rejects a body the contract does not allow', async () => {
    const both = await Promise.all([
      reportState(stream.id, { state: 'vod' }),
      reportState(stream.id, { state: 'live', index: 3 }),
      reportState(stream.id, { state: 'published' }),
    ]);
    for (const response of both) {
      assert.equal(response.status, 400, response.text);
      assert.equal(
        (response.body as { error: string }).error,
        'validation_error',
      );
    }
  });

  it('goes live: the row, and the catalogue entry a viewer reads', async () => {
    const result = await api<StreamStateResponse>(
      'POST',
      `/api/internal/streams/${stream.id}/state`,
      { ...internalCall(), body: { state: 'live' } },
    );

    assert.equal(result.stream.status, 'live');
    assert.ok(result.stream.liveSince, 'liveSince is stamped');
    assert.equal(result.stream.endedAt ?? null, null);
    assert.equal(result.stream.publishedFeedIndex, result.feed.index);

    const entry = await catalogueEntry(stream.topic);
    assert.equal(entry.state, 'live');
    assert.equal(entry.title, 'itest internal live');
    assert.ok(!('index' in entry), 'nothing to play back yet');
  });

  it('takes a repeated live report as a no-op', async () => {
    const first = await api<Stream>('GET', `/api/streams/${stream.id}`);
    const again = await api<StreamStateResponse>(
      'POST',
      `/api/internal/streams/${stream.id}/state`,
      { ...internalCall(), body: { state: 'live' } },
    );

    assert.equal(again.stream.status, 'live');
    assert.equal(
      again.stream.liveSince,
      first.liveSince,
      'liveSince does not move when the uploader retries',
    );
  });

  it('refuses to delete or unpublish a stream while it is live', async () => {
    for (const [method, path] of [
      ['DELETE', `/api/streams/${stream.id}`],
      ['POST', `/api/streams/${stream.id}/unpublish`],
    ] as [string, string][]) {
      const response = await raw(method, path);
      assert.equal(response.status, 409, `${method} ${path}`);
      assert.equal((response.body as { error: string }).error, 'stream_live');
      assert.equal(
        (response.body as { message: string }).message,
        'Stop the broadcast first.',
      );
    }
  });

  it('still serves the OBS details, so an encoder can reconnect', async () => {
    const details = await api<{ streamId: string; publishKey: string }>(
      'GET',
      `/api/streams/${stream.id}/ingest`,
    );
    assert.equal(details.streamId, `video/${stream.topic}`);
    assert.match(details.publishKey, /^[0-9a-f]{32}$/);
  });

  it('keeps the title editable but locks the schedule once live', async () => {
    const edited = await api<Stream>('PUT', `/api/streams/${stream.id}`, {
      body: { ...draft, title: 'itest internal live, edited' },
    });
    assert.equal(edited.status, 'live', 'editing does not end the broadcast');
    assert.equal(edited.title, 'itest internal live, edited');

    const rescheduled = await raw('PUT', `/api/streams/${stream.id}`, {
      body: {
        ...draft,
        title: 'itest internal live, edited',
        scheduledStartTime: '2027-01-01T09:00:00.000Z',
      },
    });
    assert.equal(rescheduled.status, 409);
    assert.equal(
      (rescheduled.body as { error: string }).error,
      'stream_locked',
    );
    assert.equal(
      (rescheduled.body as { message: string }).message,
      'The schedule cannot change once the stream has gone live.',
    );
  });

  it('republishes by hand without ending the broadcast', async () => {
    const result = await api<PublishResult>(
      'POST',
      `/api/streams/${stream.id}/publish`,
    );
    assert.equal(result.stream.status, 'live');

    const entry = await catalogueEntry(stream.topic);
    assert.equal(entry.state, 'live');
    assert.equal(entry.title, 'itest internal live, edited');
  });

  it('ends: the entry carries the manifest index and the duration', async () => {
    const result = await api<StreamStateResponse>(
      'POST',
      `/api/internal/streams/${stream.id}/state`,
      { ...internalCall(), body: { state: 'vod', index: 412, duration: 3725.5 } },
    );

    assert.equal(result.stream.status, 'vod');
    assert.equal(result.stream.manifestIndex, 412);
    assert.equal(result.stream.durationSeconds, 3725.5);
    assert.ok(result.stream.endedAt, 'endedAt is stamped');
    assert.ok(result.stream.liveSince, 'and liveSince is kept');

    const entry = await catalogueEntry(stream.topic);
    assert.equal(entry.state, 'vod');
    assert.equal(entry.index, 412);
    assert.equal(entry.duration, 3725.5);
  });

  it('refuses a live report once the recording is final', async () => {
    const response = await reportState(stream.id, { state: 'live' });
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      error: 'invalid_state_transition',
      from: 'vod',
      to: 'live',
    });
  });

  it('unpublishes a recording and clears what the uploader reported', async () => {
    const result = await api<PublishResult>(
      'POST',
      `/api/streams/${stream.id}/unpublish`,
    );
    assert.equal(result.stream.status, 'draft');
    assert.equal(result.stream.manifestIndex ?? null, null);
    assert.equal(result.stream.durationSeconds ?? null, null);
    assert.equal(result.stream.liveSince ?? null, null);
    assert.equal(result.stream.endedAt ?? null, null);
  });
});
