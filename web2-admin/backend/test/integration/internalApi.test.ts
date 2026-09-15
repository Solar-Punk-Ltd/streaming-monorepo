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
  Rendition,
  RenditionReportResponse,
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

function reportRendition(id: string, body: unknown): Promise<RawResponse> {
  return raw('POST', `/api/internal/streams/${id}/renditions`, {
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
      ['POST', `/api/internal/streams/${id}/renditions`],
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

describe('internal rendition reports', () => {
  let stream: Stream;

  /**
   * One rung of a ladder, geometry and bitrates derived from the height so two
   * rungs are never accidentally identical. The topic is a rung's own manifest
   * feed, which is a fresh UUID under the same owner — never the stream's.
   */
  const rung = (
    name: string,
    height: number,
    over: Partial<Rendition> = {},
  ): Rendition => ({
    name,
    width: Math.round((height * 16) / 9),
    height,
    topic: `bbbbbbbb-0000-4000-8000-0000000${String(height).padStart(5, '0')}`,
    bandwidth: height * 4000,
    avgBandwidth: height * 3000,
    ...over,
  });

  const report = (body: Rendition): Promise<RenditionReportResponse> =>
    api<RenditionReportResponse>(
      'POST',
      `/api/internal/streams/${stream.id}/renditions`,
      { ...internalCall(), body },
    );

  before(async () => {
    stream = await publishedStream({ title: 'itest internal ladder' });
  });

  it('404s a stream id nobody handed the uploader', async () => {
    const response = await reportRendition(
      '1867808f-7b1c-4e46-b437-f7423b466b39',
      rung('720p', 720),
    );
    assert.equal(response.status, 404);
    assert.equal((response.body as { error: string }).error, 'stream_not_found');
  });

  it('409s a draft: there is no entry to write a ladder onto', async () => {
    const unpublished = await api<Stream>('POST', '/api/streams', {
      body: draft,
    });
    created.add(unpublished.id);

    const response = await reportRendition(unpublished.id, rung('720p', 720));
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      error: 'invalid_state',
      id: unpublished.id,
      status: 'draft',
    });
  });

  it('rejects a body the contract does not allow', async () => {
    const bad = await Promise.all([
      reportRendition(stream.id, { ...rung('720p', 720), index: 4 }),
      reportRendition(stream.id, { ...rung('720p', 720), duration: 61 }),
      reportRendition(stream.id, { ...rung('720_p', 720) }),
      reportRendition(stream.id, { ...rung('720p', 720), topic: 'not-a-uuid' }),
    ]);
    for (const response of bad) {
      assert.equal(response.status, 400, response.text);
      assert.equal(
        (response.body as { error: string }).error,
        'validation_error',
      );
    }
  });

  it('puts the first rung on the catalogue entry, under the declared topic', async () => {
    const result = await report(rung('720p', 720));

    assert.equal(result.renditions.length, 1);
    assert.deepEqual(result.ladder, {
      finished: false,
      flippedToFinished: false,
      duration: null,
    });
    assert.equal(
      result.stream.status,
      'published',
      'a rendition report never moves the status',
    );
    assert.equal(result.stream.publishedFeedIndex, result.feed.index);

    const entry = await catalogueEntry(stream.topic);
    assert.equal(entry.group, stream.topic, 'the master feed is the topic');
    assert.equal(entry.renditions?.length, 1);
    assert.equal(entry.renditions?.[0]?.avgBandwidth, 720 * 3000);
    assert.equal(entry.state, 'scheduled', 'still what the state report says');
  });

  it('merges a second rung and returns the ladder ascending by height', async () => {
    const result = await report(rung('360p', 360));

    assert.deepEqual(
      result.renditions.map((r) => r.name),
      ['360p', '720p'],
    );
    assert.equal(result.ladder.finished, false);

    const entry = await catalogueEntry(stream.topic);
    assert.deepEqual(
      entry.renditions?.map((r) => r.name),
      ['360p', '720p'],
    );
  });

  it('is not finished while any rung is still delivering', async () => {
    const result = await report(rung('720p', 720, { index: 41, duration: 61.2 }));

    assert.equal(result.ladder.finished, false, '360p has not finalized');
    assert.equal(result.ladder.duration, null);
    assert.equal(result.renditions.find((r) => r.name === '720p')?.index, 41);
  });

  it('flips to finished once the last rung finalizes, with the longest duration', async () => {
    const result = await report(rung('360p', 360, { index: 12, duration: 60.8 }));

    assert.deepEqual(result.ladder, {
      finished: true,
      flippedToFinished: true,
      duration: 61.2,
    });

    const entry = await catalogueEntry(stream.topic);
    assert.equal(entry.renditions?.length, 2);
    assert.equal(entry.renditions?.[0]?.index, 12);
    assert.equal(entry.renditions?.[1]?.index, 41);
  });

  it('keeps a finished rung finished when it comes back without an index', async () => {
    // A rung recovered from a crash announces itself before it finalizes
    // again. Replacing it wholesale would un-finish the ladder and tell the
    // uploader to report `vod` a second time.
    const result = await report(rung('720p', 720, { bandwidth: 9_000_000 }));

    assert.equal(result.ladder.finished, true);
    assert.equal(
      result.ladder.flippedToFinished,
      false,
      'it was already finished, so nothing flipped',
    );
    const kept = result.renditions.find((r) => r.name === '720p');
    assert.equal(kept?.index, 41, 'the recording it already closed');
    assert.equal(kept?.duration, 61.2);
    assert.equal(kept?.bandwidth, 9_000_000, 'but the new bitrate');
  });

  it('replaces a finished rung that comes back on a fresh topic', async () => {
    // Not a recovery: an encoder that reconnected after the broadcast
    // finished. The rung is live again on a feed of its own, so the ladder is
    // no longer a finished recording. Keeping the stored record would leave
    // the master advertising the recording's rung feed while the one now being
    // written went unadvertised.
    const freshTopic = 'cccccccc-0000-4000-8000-000000000720';
    const result = await report(rung('720p', 720, { topic: freshTopic }));

    assert.equal(result.ladder.finished, false, 'one rung is delivering again');
    assert.equal(result.ladder.flippedToFinished, false);
    assert.equal(result.ladder.duration, null);

    const restarted = result.renditions.find((r) => r.name === '720p');
    assert.equal(restarted?.topic, freshTopic);
    assert.equal(restarted?.index, undefined, 'the old recording is gone');
    assert.equal(
      result.renditions.find((r) => r.name === '360p')?.index,
      12,
      'the rung that did not restart keeps its recording',
    );

    const entry = await catalogueEntry(stream.topic);
    assert.equal(
      entry.renditions?.find((r) => r.name === '720p')?.topic,
      freshTopic,
      'the catalogue points at the feed being written now',
    );
  });

  it('carries the ladder through a state report and a hand republish', async () => {
    const ended = await api<StreamStateResponse>(
      'POST',
      `/api/internal/streams/${stream.id}/state`,
      { ...internalCall(), body: { state: 'vod', index: 9, duration: 61.2 } },
    );
    assert.equal(ended.stream.status, 'vod');

    const afterState = await catalogueEntry(stream.topic);
    assert.equal(afterState.state, 'vod');
    assert.equal(afterState.index, 9, 'the master, not a rung');
    assert.equal(afterState.renditions?.length, 2, 'the ladder is still there');

    await api<PublishResult>('POST', `/api/streams/${stream.id}/publish`);
    const afterRepublish = await catalogueEntry(stream.topic);
    assert.equal(afterRepublish.renditions?.length, 2);
  });

  it('drops the ladder when the recording is unpublished', async () => {
    const result = await api<PublishResult>(
      'POST',
      `/api/streams/${stream.id}/unpublish`,
    );
    assert.equal(result.stream.status, 'draft');

    const rows = await pool.query(
      'SELECT 1 FROM stream_renditions WHERE stream_id = $1',
      [stream.id],
    );
    assert.equal(rows.rowCount, 0, 'the rungs went with the state columns');

    // And a fresh publish of the same row announces a single-rendition stream.
    const republished = await api<PublishResult>(
      'POST',
      `/api/streams/${stream.id}/publish`,
    );
    assert.equal(republished.stream.status, 'published');
    const entry = await catalogueEntry(stream.topic);
    assert.ok(!('renditions' in entry), 'no ladder');
    assert.ok(!('group' in entry), 'and no group');
  });
});
