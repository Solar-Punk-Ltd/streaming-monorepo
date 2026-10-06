/**
 * The internal API against the RUNNING backend: what the swarm-hls-stream
 * uploader does when an encoder connects, and what it reports afterwards.
 *
 * Prerequisites (from apps/web2-admin/backend/):
 *
 *   pnpm database:start                     # Postgres on 127.0.0.1:5433
 *   pnpm test:integration
 *
 * The suite starts a backend of its own on a free port, against a throwaway
 * database, with FEED_GATEWAY=fake and the suite's own INTERNAL_API_TOKEN —
 * see instance.ts — so it never reports state through an instance pointed at
 * a real Bee node. It reads that database directly as well.
 *
 * The catalogue entry is read back from `feed_writes`, the log of what the
 * backend believes it wrote: the assertion that matters here is not that the
 * row flipped to `live` but that the entry a viewer reads did, and the HTTP
 * response cannot show that.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

import { STAGE_ID, stageRecord } from '../unit/support/stageFakes.js';

import {
  api,
  INTERNAL_API_TOKEN,
  internalCall,
  login,
  raw,
  registerStage,
  releaseStack,
  requireStack,
  stack,
  type RawResponse,
  UPLOADER_TOKEN,
  uploaderCall,
} from './helpers.js';

const RECORDING = 'ab'.repeat(32);
const RECORDING_360 = 'a1'.repeat(32);
const RECORDING_720 = 'b2'.repeat(32);
const RECORDING_MASTER = 'c3'.repeat(32);

const draft = {
  title: 'itest internal',
  description: 'Created by the web2-admin internal API suite.',
  tags: ['itest'],
  mediaType: 'video' as const,
  scheduledStartTime: '2026-10-01T09:00:00.000Z',
  // Registered in `before`: a draft with no stage is refused at publish.
  stageId: STAGE_ID,
};

const created = new Set<string>();
let pool: pg.Pool;

before(async () => {
  await requireStack();
  // With the token its uploader presents, of its own: the uploader's routes take no other.
  await registerStage({}, UPLOADER_TOKEN);
  await login();
  pool = new pg.Pool({ connectionString: stack().databaseUrl, max: 2 });
});

after(async () => {
  await login();
  for (const id of created) {
    // A live stream refuses both, which is the point of one of the tests
    // below; end it first so the row can be cleaned up like any other.
    const stream = await raw('GET', `/api/streams/${id}`);
    if ((stream.body as Stream | undefined)?.status === 'live') {
      await reportState(id, { state: 'vod', recording: RECORDING, duration: 1 });
    }
    await raw('POST', `/api/streams/${id}/unpublish`);
    await raw('DELETE', `/api/streams/${id}`);
  }
  await pool?.end();
  await releaseStack();
});

async function publishedStream(overrides: Partial<typeof draft> = {}): Promise<Stream> {
  const stream = await api<Stream>('POST', '/api/streams', {
    body: { ...draft, ...overrides },
  });
  created.add(stream.id);
  const result = await api<PublishResult>('POST', `/api/streams/${stream.id}/publish`);
  return result.stream;
}

function reportState(id: string, body: unknown): Promise<RawResponse> {
  return raw('POST', `/api/internal/streams/${id}/state`, {
    ...uploaderCall(),
    body,
  });
}

function reportRendition(id: string, body: unknown): Promise<RawResponse> {
  return raw('POST', `/api/internal/streams/${id}/renditions`, {
    ...uploaderCall(),
    body,
  });
}

/**
 * The entry for this topic in the newest feed write that contains it. Every such row also carries the exact string
 * the gateway was handed (migration 013), which must read back as the payload, and no batch: this instance runs the
 * in-memory gateway with no catalogue stamp.
 */
async function catalogueEntry(topic: string): Promise<FeedStreamEntry> {
  const result = await pool.query<{ payload: unknown[]; payload_text: string | null; batch_id: string | null }>(
    `SELECT payload, payload_text, batch_id FROM feed_writes
      WHERE payload @> $1::jsonb
      ORDER BY id DESC
      LIMIT 1`,
    [JSON.stringify([{ topic }])],
  );
  const payload = result.rows[0]?.payload;
  assert.ok(payload, `no feed write contains topic ${topic}`);
  assert.deepEqual(JSON.parse(result.rows[0]!.payload_text ?? 'null'), payload, 'payload_text is not the payload');
  assert.equal(result.rows[0]!.batch_id, null);
  const entry = payload.find((e) => (e as FeedStreamEntry | null)?.topic === topic);
  assert.ok(entry, `topic ${topic} not in the payload`);
  return entry as FeedStreamEntry;
}

/** Whether the newest feed write, the catalogue as it stands, lists this topic. */
async function isOnCatalogue(topic: string): Promise<boolean> {
  const result = await pool.query<{ listed: boolean }>(
    `SELECT payload @> $1::jsonb AS listed FROM feed_writes
      ORDER BY id DESC
      LIMIT 1`,
    [JSON.stringify([{ topic }])],
  );
  return result.rows[0]?.listed ?? false;
}

describe('internal API authentication', () => {
  it('refuses every uploader route without a stage’s own token', async () => {
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
    const response = await raw('GET', '/api/internal/streams/by-ingest/video/1867808f-7b1c-4e46-b437-f7423b466b39');
    assert.equal(response.status, 401);
  });
});

describe('the registrar token', () => {
  // A stage still on a copy of the registrar token, which an older manager copied into its deployment: the record
  // says `shared`, and the stage has to rotate its token in the manager.
  const COPIED_STAGE = 'bf628a4e-7182-43a4-9fa6-60718293a4b5';
  let stream: Stream;

  before(async () => {
    await registerStage({
      stageId: COPIED_STAGE,
      name: 'Copied stage',
      adminToken: { sha256: createHash('sha256').update(INTERNAL_API_TOKEN, 'utf8').digest('hex'), kind: 'shared' },
    });
    stream = await publishedStream({ title: 'itest on a stage still on the registrar token', stageId: COPIED_STAGE });
  });

  it('is refused on every uploader route, plainly, and writes nothing', async () => {
    const writes = await pool.query<{ count: string }>('SELECT count(*) AS count FROM feed_writes');
    const calls: [string, string, unknown][] = [
      ['GET', `/api/internal/streams/by-ingest/video/${stream.topic}`, undefined],
      ['POST', `/api/internal/streams/${stream.id}/state`, { state: 'live' }],
      [
        'POST',
        `/api/internal/streams/${stream.id}/renditions`,
        {
          name: '720p',
          width: 1280,
          height: 720,
          topic: 'bbbbbbbb-0000-4000-8000-000000000720',
          bandwidth: 2_880_000,
          avgBandwidth: 2_160_000,
        },
      ],
      ['GET', '/api/internal/stages/self', undefined],
    ];
    for (const [method, path, body] of calls) {
      const answer = await raw(method, path, { ...internalCall(), body });
      assert.equal(answer.status, 401, `${method} ${path} took the registrar token`);
      assert.deepEqual(answer.body, { error: 'unauthenticated' });
    }
    const after = await pool.query<{ count: string }>('SELECT count(*) AS count FROM feed_writes');
    assert.equal(after.rows[0]?.count, writes.rows[0]?.count, 'a refused call wrote to the feed');
    assert.equal((await api<Stream>('GET', `/api/streams/${stream.id}`)).status, 'published');
  });

  it('is never stored as a stage’s own token: the push is refused and registers nothing', async () => {
    const stageId = 'd1840c6a-93a4-45c6-9b17-8293a4b5c6d7';
    const pushed = await raw('PUT', `/api/internal/stages/${stageId}`, {
      ...internalCall(),
      body: stageRecord({
        stageId,
        name: 'Pushed with the registrar token',
        adminToken: { sha256: createHash('sha256').update(INTERNAL_API_TOKEN, 'utf8').digest('hex'), kind: 'own' },
      }),
    });
    assert.equal(pushed.status, 400, pushed.text);
    const rows = await pool.query('SELECT 1 FROM stages WHERE stage_id = $1', [stageId]);
    assert.equal(rows.rowCount, 0);
  });

  it('passes the registrar check, which answers 204 and takes no uploader’s token', async () => {
    const checked = await raw('GET', '/api/internal/registrar', internalCall());
    assert.equal(checked.status, 204);
    assert.equal(checked.text, '');

    for (const options of [uploaderCall(), { anonymous: true, crossSiteHeader: false }]) {
      const refused = await raw('GET', '/api/internal/registrar', options);
      assert.equal(refused.status, 401);
      assert.deepEqual(refused.body, { error: 'unauthenticated' });
    }
  });

  it('reads an unknown internal path as a 404, as a stage’s own token does, and no token as a 401', async () => {
    for (const options of [internalCall(), uploaderCall()]) {
      const answer = await raw('GET', '/api/internal/nothing-here', options);
      assert.equal(answer.status, 404);
      assert.equal((answer.body as { error: string }).error, 'not_found');
    }
    const anonymous = await raw('GET', '/api/internal/nothing-here', { anonymous: true, crossSiteHeader: false });
    assert.equal(anonymous.status, 401);
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
      uploaderCall(),
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

    const response = await raw('GET', `/api/internal/streams/by-ingest/video/${unpublished.topic}`, uploaderCall());
    assert.equal(response.status, 404);
    assert.equal((response.body as { error: string }).error, 'stream_not_found');
  });

  it('refuses the right topic under the wrong app', async () => {
    // `<mediaType>/<topic>` is the whole ingest address; half of it matching
    // is not a match.
    const response = await raw('GET', `/api/internal/streams/by-ingest/audio/${stream.topic}`, uploaderCall());
    assert.equal(response.status, 404);
    assert.equal((response.body as { error: string }).error, 'stream_not_found');
  });

  it('404s an unknown topic and 400s a malformed one', async () => {
    const unknown = await raw(
      'GET',
      '/api/internal/streams/by-ingest/video/1867808f-7b1c-4e46-b437-f7423b466b39',
      uploaderCall(),
    );
    assert.equal(unknown.status, 404);

    const malformed = await raw('GET', '/api/internal/streams/by-ingest/video/not-a-uuid', uploaderCall());
    assert.equal(malformed.status, 400);
    assert.equal((malformed.body as { error: string }).error, 'validation_error');
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
      reportState(stream.id, { state: 'live', recording: RECORDING }),
      reportState(stream.id, { state: 'vod', index: 412, recording: RECORDING, duration: 1 }),
      reportState(stream.id, { state: 'live', index: 3 }),
      reportState(stream.id, { state: 'published' }),
    ]);
    for (const response of both) {
      assert.equal(response.status, 400, response.text);
      assert.equal((response.body as { error: string }).error, 'validation_error');
    }
  });

  it('goes live: the row, and the catalogue entry a viewer reads', async () => {
    const result = await api<StreamStateResponse>('POST', `/api/internal/streams/${stream.id}/state`, {
      ...uploaderCall(),
      body: { state: 'live' },
    });

    assert.equal(result.stream.status, 'live');
    assert.ok(result.stream.liveSince, 'liveSince is stamped');
    assert.equal(result.stream.endedAt ?? null, null);
    assert.equal(result.stream.publishedFeedIndex, result.feed.index);
    assert.equal(result.stream.hasUnpublishedEdits, false, 'a report moves the row but is not an edit to republish');

    const entry = await catalogueEntry(stream.topic);
    assert.equal(entry.state, 'live');
    assert.equal(entry.title, 'itest internal live');
    assert.ok(!('recording' in entry), 'nothing to play back yet');
  });

  it('takes a repeated live report as a no-op', async () => {
    const first = await api<Stream>('GET', `/api/streams/${stream.id}`);
    const again = await api<StreamStateResponse>('POST', `/api/internal/streams/${stream.id}/state`, {
      ...uploaderCall(),
      body: { state: 'live' },
    });

    assert.equal(again.stream.status, 'live');
    assert.equal(again.stream.liveSince, first.liveSince, 'liveSince does not move when the uploader retries');
  });

  it('refuses to delete or unpublish a stream while it is live', async () => {
    for (const [method, path] of [
      ['DELETE', `/api/streams/${stream.id}`],
      ['POST', `/api/streams/${stream.id}/unpublish`],
    ] as [string, string][]) {
      const response = await raw(method, path);
      assert.equal(response.status, 409, `${method} ${path}`);
      assert.equal((response.body as { error: string }).error, 'stream_live');
      assert.equal((response.body as { message: string }).message, 'Stop the broadcast first.');
    }
  });

  it('still serves the OBS details, so an encoder can reconnect', async () => {
    const details = await api<{ streamId: string; publishKey: string }>('GET', `/api/streams/${stream.id}/ingest`);
    assert.equal(details.streamId, `video/${stream.topic}`);
    assert.match(details.publishKey, /^[0-9a-f]{32}$/);
  });

  it('keeps the title editable but locks the schedule once live', async () => {
    const edited = await api<Stream>('PUT', `/api/streams/${stream.id}`, {
      body: { ...draft, title: 'itest internal live, edited' },
    });
    assert.equal(edited.status, 'live', 'editing does not end the broadcast');
    assert.equal(edited.title, 'itest internal live, edited');
    assert.equal(edited.hasUnpublishedEdits, true, 'not on the entry yet');

    const rescheduled = await raw('PUT', `/api/streams/${stream.id}`, {
      body: {
        ...draft,
        title: 'itest internal live, edited',
        scheduledStartTime: '2027-01-01T09:00:00.000Z',
      },
    });
    assert.equal(rescheduled.status, 409);
    assert.equal((rescheduled.body as { error: string }).error, 'stream_locked');
    assert.equal(
      (rescheduled.body as { message: string }).message,
      'The schedule cannot change once the stream has gone live.',
    );
  });

  it('republishes by hand without ending the broadcast', async () => {
    const result = await api<PublishResult>('POST', `/api/streams/${stream.id}/publish`);
    assert.equal(result.stream.status, 'live');
    assert.equal(result.stream.hasUnpublishedEdits, false, 'the edit went out');

    const entry = await catalogueEntry(stream.topic);
    assert.equal(entry.state, 'live');
    assert.equal(entry.title, 'itest internal live, edited');
  });

  it('ends: the entry carries the recording and the duration', async () => {
    const result = await api<StreamStateResponse>('POST', `/api/internal/streams/${stream.id}/state`, {
      ...uploaderCall(),
      body: { state: 'vod', recording: RECORDING, duration: 3725.5 },
    });

    assert.equal(result.stream.status, 'vod');
    assert.equal(result.stream.recording, RECORDING);
    assert.equal(result.stream.durationSeconds, 3725.5);
    assert.ok(result.stream.endedAt, 'endedAt is stamped');
    assert.ok(result.stream.liveSince, 'and liveSince is kept');
    assert.equal(
      result.stream.hasUnpublishedEdits,
      false,
      'a recording nobody edited since its republish has nothing to republish',
    );

    const entry = await catalogueEntry(stream.topic);
    assert.equal(entry.state, 'vod');
    assert.equal(entry.recording, RECORDING);
    assert.equal(entry.duration, 3725.5);
  });

  it('goes live again after the recording, dropping what it had finished', async () => {
    // The broadcast continues on the feeds it already owns, so a reconnecting
    // encoder resumes this stream rather than needing a new one. What it must
    // not keep is the previous recording: the entry would point a viewer at a
    // finished recording while a new session writes over its head.
    const result = await api<StreamStateResponse>('POST', `/api/internal/streams/${stream.id}/state`, {
      ...uploaderCall(),
      body: { state: 'live' },
    });

    assert.equal(result.stream.status, 'live');
    assert.equal(result.stream.recording ?? null, null);
    assert.equal(result.stream.durationSeconds ?? null, null);
    assert.equal(result.stream.endedAt ?? null, null);
    assert.ok(result.stream.liveSince, 'a fresh live run is stamped');

    const entry = await catalogueEntry(stream.topic);
    assert.equal(entry.state, 'live');
    assert.equal(entry.recording ?? null, null, 'no recording while it is live');
    assert.equal(entry.duration ?? null, null);

    // And back to a recording, which is the state the rest of this sequence
    // starts from.
    const ended = await api<StreamStateResponse>('POST', `/api/internal/streams/${stream.id}/state`, {
      ...uploaderCall(),
      body: { state: 'vod', recording: RECORDING, duration: 3725.5 },
    });
    assert.equal(ended.stream.status, 'vod');
  });

  it('unpublishes a recording and keeps what the uploader reported', async () => {
    const result = await api<PublishResult>('POST', `/api/streams/${stream.id}/unpublish`);
    assert.equal(result.stream.status, 'draft');
    assert.equal(result.stream.publishedFeedIndex ?? null, null);
    assert.equal(result.stream.recording, RECORDING, 'where the recording is');
    assert.equal(result.stream.durationSeconds, 3725.5, 'how long it runs');
    assert.ok(result.stream.liveSince, 'when it went live');
    assert.ok(result.stream.endedAt, 'when it ended');
    assert.equal(await isOnCatalogue(stream.topic), false, 'off the catalogue');
  });

  it('publishes it again as the recording, never as a stream that has not started', async () => {
    const result = await api<PublishResult>('POST', `/api/streams/${stream.id}/publish`);
    assert.equal(result.stream.status, 'vod');
    assert.equal(result.stream.recording, RECORDING);

    const entry = await catalogueEntry(stream.topic);
    assert.equal(entry.state, 'vod');
    assert.equal(entry.recording, RECORDING);
    assert.equal(entry.duration, 3725.5);
  });
});

describe('internal rendition reports', () => {
  let stream: Stream;

  /**
   * One rung of a ladder, geometry and bitrates derived from the height so two
   * rungs are never accidentally identical. The topic is a rung's own manifest
   * feed, which is a fresh UUID under the same owner — never the stream's.
   */
  const rung = (name: string, height: number, over: Partial<Rendition> = {}): Rendition => ({
    name,
    width: Math.round((height * 16) / 9),
    height,
    topic: `bbbbbbbb-0000-4000-8000-0000000${String(height).padStart(5, '0')}`,
    bandwidth: height * 4000,
    avgBandwidth: height * 3000,
    ...over,
  });

  const report = (body: Rendition): Promise<RenditionReportResponse> =>
    api<RenditionReportResponse>('POST', `/api/internal/streams/${stream.id}/renditions`, { ...uploaderCall(), body });

  before(async () => {
    stream = await publishedStream({ title: 'itest internal ladder' });
  });

  it('404s a stream id nobody handed the uploader', async () => {
    const response = await reportRendition('1867808f-7b1c-4e46-b437-f7423b466b39', rung('720p', 720));
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
      reportRendition(stream.id, { ...rung('720p', 720), recording: RECORDING }),
      reportRendition(stream.id, { ...rung('720p', 720), duration: 61 }),
      reportRendition(stream.id, { ...rung('720p', 720), index: 4, recording: RECORDING, duration: 61 }),
      reportRendition(stream.id, { ...rung('720_p', 720) }),
      reportRendition(stream.id, { ...rung('720p', 720), topic: 'not-a-uuid' }),
    ]);
    for (const response of bad) {
      assert.equal(response.status, 400, response.text);
      assert.equal((response.body as { error: string }).error, 'validation_error');
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
    assert.equal(result.stream.status, 'published', 'a rendition report never moves the status');
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
    const result = await report(rung('720p', 720, { recording: RECORDING_720, duration: 61.2 }));

    assert.equal(result.ladder.finished, false, '360p has not finalized');
    assert.equal(result.ladder.duration, null);
    assert.equal(result.renditions.find((r) => r.name === '720p')?.recording, RECORDING_720);
  });

  it('flips to finished once the last rung finalizes, with the longest duration', async () => {
    const result = await report(rung('360p', 360, { recording: RECORDING_360, duration: 60.8 }));

    assert.deepEqual(result.ladder, {
      finished: true,
      flippedToFinished: true,
      duration: 61.2,
    });

    const entry = await catalogueEntry(stream.topic);
    assert.equal(entry.renditions?.length, 2);
    assert.equal(entry.renditions?.[0]?.recording, RECORDING_360);
    assert.equal(entry.renditions?.[1]?.recording, RECORDING_720);
  });

  it('keeps a finished rung finished when it comes back without a recording', async () => {
    // A rung recovered from a crash announces itself before it finalizes
    // again. Replacing it wholesale would un-finish the ladder and tell the
    // uploader to report `vod` a second time.
    const result = await report(rung('720p', 720, { bandwidth: 9_000_000 }));

    assert.equal(result.ladder.finished, true);
    assert.equal(result.ladder.flippedToFinished, false, 'it was already finished, so nothing flipped');
    const kept = result.renditions.find((r) => r.name === '720p');
    assert.equal(kept?.recording, RECORDING_720, 'the recording it already closed');
    assert.equal(kept?.duration, 61.2);
    assert.equal(kept?.bandwidth, 9_000_000, 'but the new bitrate');
  });

  it('takes a rung that reports on a different feed as it arrived', async () => {
    // A rung's topic is derived from the stream's topic and the rung name, so
    // in a well-formed ladder every report for a rung names the feed its
    // recordings already sit on. A report naming some other feed describes a
    // recording this ladder has nothing to say about, so nothing is carried
    // over: keeping the stored recording would leave the master advertising a feed
    // the report did not mention.
    const freshTopic = 'cccccccc-0000-4000-8000-000000000720';
    const result = await report(rung('720p', 720, { topic: freshTopic }));

    assert.equal(result.ladder.finished, false, 'that rung has no recording');
    assert.equal(result.ladder.flippedToFinished, false);
    assert.equal(result.ladder.duration, null);

    const foreign = result.renditions.find((r) => r.name === '720p');
    assert.equal(foreign?.topic, freshTopic);
    assert.equal(foreign?.recording, undefined, 'nothing was carried over');
    assert.equal(
      result.renditions.find((r) => r.name === '360p')?.recording,
      RECORDING_360,
      'the rung that stayed on its own feed keeps its recording',
    );

    const entry = await catalogueEntry(stream.topic);
    assert.equal(
      entry.renditions?.find((r) => r.name === '720p')?.topic,
      freshTopic,
      'the catalogue points at the feed being written now',
    );
  });

  it('carries the ladder through a state report and a hand republish', async () => {
    const ended = await api<StreamStateResponse>('POST', `/api/internal/streams/${stream.id}/state`, {
      ...uploaderCall(),
      body: { state: 'vod', recording: RECORDING_MASTER, duration: 61.2 },
    });
    assert.equal(ended.stream.status, 'vod');

    const afterState = await catalogueEntry(stream.topic);
    assert.equal(afterState.state, 'vod');
    assert.equal(afterState.recording, RECORDING_MASTER, 'the master, not a rung');
    assert.equal(afterState.renditions?.length, 2, 'the ladder is still there');

    await api<PublishResult>('POST', `/api/streams/${stream.id}/publish`);
    const afterRepublish = await catalogueEntry(stream.topic);
    assert.equal(afterRepublish.renditions?.length, 2);
  });

  it('un-finishes every rung when the broadcast goes live again', async () => {
    // Each rung continues on the feed it already owns, so the ladder survives
    // the resume — but not the recordings, which name the take that just
    // ended. They come back one final report at a time.
    const live = await api<StreamStateResponse>('POST', `/api/internal/streams/${stream.id}/state`, {
      ...uploaderCall(),
      body: { state: 'live' },
    });
    assert.equal(live.stream.status, 'live');

    const rows = await pool.query<{
      name: string;
      recording_ref: string | null;
      duration_seconds: string | null;
    }>(
      `SELECT name, recording_ref, duration_seconds FROM stream_renditions
        WHERE stream_id = $1 ORDER BY name`,
      [stream.id],
    );
    assert.equal(rows.rowCount, 2, 'the rungs themselves stay');
    for (const row of rows.rows) {
      assert.equal(row.recording_ref, null, `${row.name} recording`);
      assert.equal(row.duration_seconds, null, `${row.name} duration`);
    }

    const entry = await catalogueEntry(stream.topic);
    assert.equal(entry.state, 'live');
    assert.equal(entry.renditions?.length, 2);
    assert.equal(
      entry.renditions?.every((r) => r.recording === undefined),
      true,
      'and the catalogue advertises none of the old recordings',
    );

    // Back to a recording for the unpublish that follows.
    await api<StreamStateResponse>('POST', `/api/internal/streams/${stream.id}/state`, {
      ...uploaderCall(),
      body: { state: 'vod', recording: RECORDING_MASTER, duration: 61.2 },
    });
  });

  it('keeps the ladder when the recording is unpublished, and publishes it back with it', async () => {
    const result = await api<PublishResult>('POST', `/api/streams/${stream.id}/unpublish`);
    assert.equal(result.stream.status, 'draft');
    assert.equal(await isOnCatalogue(stream.topic), false, 'off the catalogue');

    const rows = await pool.query('SELECT 1 FROM stream_renditions WHERE stream_id = $1', [stream.id]);
    assert.equal(rows.rowCount, 2, 'the rungs stay with the recording');

    // And the next publish lists the same recording, ladder and all.
    const republished = await api<PublishResult>('POST', `/api/streams/${stream.id}/publish`);
    assert.equal(republished.stream.status, 'vod');
    const entry = await catalogueEntry(stream.topic);
    assert.equal(entry.state, 'vod');
    assert.equal(entry.recording, RECORDING_MASTER, 'the master, as before');
    assert.equal(entry.group, stream.topic);
    assert.equal(entry.renditions?.length, 2);
  });
});

describe('an uploader on a token of its own', () => {
  // A second stage, registered with the token its uploader presents, of its own. `STAGE_ID`'s uploader is on
  // `UPLOADER_TOKEN`.
  const OWN_STAGE = '6a1d3b9f-2c3d-4e5f-8a51-1b2c3d4e5f60';
  const OWN_OWNER = '0x' + '5c'.repeat(20);
  // 64 hex characters, as the manager generates a stage's own token; the admin asks for no other shape.
  const OWN_TOKEN = '7e'.repeat(32);
  let mine: Stream;
  let theirs: Stream;

  before(async () => {
    await registerStage({ stageId: OWN_STAGE, name: 'Own stage', owner: OWN_OWNER }, OWN_TOKEN);
    mine = await publishedStream({ title: 'itest on its own stage', stageId: OWN_STAGE });
    theirs = await publishedStream({ title: 'itest on the main stage' });
  });

  async function feedWriteCount(): Promise<number> {
    const result = await pool.query<{ count: string }>('SELECT count(*) AS count FROM feed_writes');
    return Number(result.rows[0]?.count);
  }

  it('names its stage and the owner that stage signs as', async () => {
    const self = await raw('GET', '/api/internal/stages/self', uploaderCall(OWN_TOKEN));
    assert.equal(self.status, 200, self.text);
    assert.deepEqual(self.body, { stageId: OWN_STAGE, owner: OWN_OWNER });

    const main = await raw('GET', '/api/internal/stages/self', uploaderCall());
    assert.equal(main.status, 200, main.text);
    assert.equal((main.body as { stageId: string }).stageId, STAGE_ID);
  });

  it('finds its own stage’s stream, and not another stage’s', async () => {
    const found = await api<IngestLookupResponse>(
      'GET',
      `/api/internal/streams/by-ingest/video/${mine.topic}`,
      uploaderCall(OWN_TOKEN),
    );
    assert.equal(found.id, mine.id);

    const other = await raw('GET', `/api/internal/streams/by-ingest/video/${theirs.topic}`, uploaderCall(OWN_TOKEN));
    assert.equal(other.status, 404);
    assert.equal((other.body as { error: string }).error, 'stream_not_found');

    const main = await api<IngestLookupResponse>(
      'GET',
      `/api/internal/streams/by-ingest/video/${theirs.topic}`,
      uploaderCall(),
    );
    assert.equal(main.id, theirs.id, 'the main stage’s own token finds its own stream');
  });

  it('reports nothing for another stage’s stream, and writes nothing', async () => {
    const writes = await feedWriteCount();

    const state = await raw('POST', `/api/internal/streams/${theirs.id}/state`, {
      ...uploaderCall(OWN_TOKEN),
      body: { state: 'live' },
    });
    assert.equal(state.status, 404);
    assert.equal((state.body as { error: string }).error, 'stream_not_found');

    const rung = await raw('POST', `/api/internal/streams/${theirs.id}/renditions`, {
      ...uploaderCall(OWN_TOKEN),
      body: {
        name: '720p',
        width: 1280,
        height: 720,
        topic: 'bbbbbbbb-0000-4000-8000-000000000720',
        bandwidth: 2_880_000,
        avgBandwidth: 2_160_000,
      },
    });
    assert.equal(rung.status, 404);

    assert.equal(await feedWriteCount(), writes, 'no feed write');
    const rungs = await pool.query('SELECT 1 FROM stream_renditions WHERE stream_id = $1', [theirs.id]);
    assert.equal(rungs.rowCount, 0, 'no rung stored');
    assert.equal((await api<Stream>('GET', `/api/streams/${theirs.id}`)).status, 'published');
  });

  it('reports for its own stage’s stream', async () => {
    const live = await api<StreamStateResponse>('POST', `/api/internal/streams/${mine.id}/state`, {
      ...uploaderCall(OWN_TOKEN),
      body: { state: 'live' },
    });
    assert.equal(live.stream.status, 'live');
    assert.equal((await catalogueEntry(mine.topic)).state, 'live');
  });

  it('is refused on the manager’s routes, and everywhere once its stage is retired', async () => {
    const push = await raw('PUT', `/api/internal/stages/${OWN_STAGE}`, {
      ...uploaderCall(OWN_TOKEN),
      body: stageRecord({ stageId: OWN_STAGE, name: 'Own stage', owner: OWN_OWNER }),
    });
    assert.equal(push.status, 401);

    const retired = await raw('DELETE', `/api/internal/stages/${OWN_STAGE}`, {
      ...internalCall(),
      body: { observedAt: '2026-09-28T10:05:00.000Z' },
    });
    assert.deepEqual(retired.body, { retired: true });

    for (const path of ['/api/internal/stages/self', `/api/internal/streams/by-ingest/video/${mine.topic}`]) {
      const answer = await raw('GET', path, uploaderCall(OWN_TOKEN));
      assert.equal(answer.status, 401, path);
    }
  });
});
