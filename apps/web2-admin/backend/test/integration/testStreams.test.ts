/**
 * A test stream against the RUNNING backend and its database: created in the console, looked up and reported on by
 * its stage's uploader from draft to live to recorded, and given a viewer address, with the catalogue untouched at
 * every step. See README.md for how the suite runs.
 *
 * The catalogue is read from `feed_writes`, the log of every write the backend made: a test stream must appear in
 * none, and its reports must add none.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  NOT_TEST_STREAM_ERROR,
  TEST_STREAMS_PATH,
  testStreamViewerUrlPath,
  viewerUrlProblem,
  type IngestLookupResponse,
  type PublishResult,
  type Rendition,
  type RenditionReportResponse,
  type Stream,
  type StreamStateResponse,
} from '@streaming-monorepo/web2-admin-common';
import pg from 'pg';

import { STAGE_ID } from '../unit/support/stageFakes.js';

import {
  api,
  login,
  raw,
  registerStage,
  releaseStack,
  requireStack,
  stack,
  UPLOADER_TOKEN,
  uploaderCall,
} from './helpers.js';

const created = new Set<string>();
let pool: pg.Pool;

before(async () => {
  await requireStack();
  await registerStage({}, UPLOADER_TOKEN);
  await login();
  pool = new pg.Pool({ connectionString: stack().databaseUrl, max: 2 });
});

after(async () => {
  await login();
  for (const id of created) {
    const stream = await raw('GET', `/api/streams/${id}`);
    const status = (stream.body as Stream | undefined)?.status;
    if (status === 'live')
      await raw('POST', `/api/internal/streams/${id}/state`, {
        ...uploaderCall(),
        body: { state: 'vod', index: 0, duration: 1 },
      });
    if (status === 'published' || status === 'live' || status === 'vod')
      await raw('POST', `/api/streams/${id}/unpublish`);
    await raw('DELETE', `/api/streams/${id}`);
  }
  await pool?.end();
  await releaseStack();
});

async function createTestStream(title = 'itest test stream'): Promise<Stream> {
  const stream = await api<Stream>('POST', TEST_STREAMS_PATH, {
    body: { title, mediaType: 'video', stageId: STAGE_ID },
  });
  created.add(stream.id);
  return stream;
}

function rung(name: string, height: number, final?: { index: number; duration: number }): Rendition {
  return {
    name,
    width: Math.round((height * 16) / 9),
    height,
    topic: `cccccccc-0000-4000-8000-0000000${String(height).padStart(5, '0')}`,
    bandwidth: height * 4000,
    avgBandwidth: height * 3000,
    ...(final ?? {}),
  };
}

async function reportState(id: string, body: unknown): Promise<StreamStateResponse> {
  return api<StreamStateResponse>('POST', `/api/internal/streams/${id}/state`, { ...uploaderCall(), body });
}

async function reportRendition(id: string, body: Rendition): Promise<RenditionReportResponse> {
  return api<RenditionReportResponse>('POST', `/api/internal/streams/${id}/renditions`, { ...uploaderCall(), body });
}

/** How many catalogue writes the backend has made, and how many of them name `topic`. */
async function catalogueWrites(topic: string): Promise<{ all: number; naming: number }> {
  const result = await pool.query<{ all: string; naming: string }>(
    `SELECT count(*) AS all,
            count(*) FILTER (WHERE payload::text LIKE '%' || $1 || '%') AS naming
       FROM feed_writes`,
    [topic],
  );
  return { all: Number(result.rows[0]!.all), naming: Number(result.rows[0]!.naming) };
}

describe('a test stream on its stage', () => {
  it('is created with an empty description, marked a test on its row', async () => {
    const stream = await createTestStream();

    assert.equal(stream.test, true);
    assert.equal(stream.description, '');
    const row = await pool.query<{ test: boolean; description: string; report_order: number }>(
      'SELECT test, description, report_order FROM streams WHERE id = $1',
      [stream.id],
    );
    assert.deepEqual(row.rows[0], { test: true, description: '', report_order: 0 });
  });

  it('goes from draft to live to recorded with the catalogue untouched at every step', async () => {
    const stream = await createTestStream();
    const before = await catalogueWrites(stream.topic);

    const lookup = await api<IngestLookupResponse>(
      'GET',
      `/api/internal/streams/by-ingest/video/${stream.topic}`,
      uploaderCall(),
    );
    assert.equal(lookup.id, stream.id);
    assert.equal(lookup.status, 'draft');
    assert.deepEqual(await catalogueWrites(stream.topic), before);

    const live = await reportState(stream.id, { state: 'live' });
    assert.equal(live.stream.status, 'live');
    assert.equal(live.written, false);
    assert.equal(live.feed.index, 1);
    assert.deepEqual(await catalogueWrites(stream.topic), before);

    const first = await reportRendition(stream.id, rung('360p', 360));
    assert.equal(first.feed.index, 2);
    assert.deepEqual(
      first.renditions.map((r) => r.name),
      ['360p'],
    );
    const final = await reportRendition(stream.id, rung('360p', 360, { index: 9, duration: 30 }));
    assert.equal(final.ladder.flippedToFinished, true);
    assert.deepEqual(await catalogueWrites(stream.topic), before);

    const vod = await reportState(stream.id, { state: 'vod', index: 5, duration: 30 });
    assert.equal(vod.stream.status, 'vod');
    assert.equal(vod.stream.manifestIndex, 5);
    assert.equal(vod.written, false);
    assert.deepEqual(await catalogueWrites(stream.topic), before);

    const row = await pool.query<{
      published_feed_index: number | null;
      published_at: Date | null;
      report_order: number;
    }>('SELECT published_feed_index, published_at, report_order FROM streams WHERE id = $1', [stream.id]);
    assert.deepEqual(row.rows[0], { published_feed_index: null, published_at: null, report_order: 4 });

    const deleted = await raw('DELETE', `/api/streams/${stream.id}`);
    assert.equal(deleted.status, 204, 'a recorded test stream is deleted, with nothing to unpublish');
    created.delete(stream.id);
  });

  it('is looked up while another stream on its stage is live', async () => {
    const event = await api<Stream>('POST', '/api/streams', {
      body: {
        title: 'itest event beside a test',
        description: 'A stream live on the same stage.',
        tags: [],
        mediaType: 'video',
        scheduledStartTime: '2026-10-01T09:00:00.000Z',
        stageId: STAGE_ID,
      },
    });
    created.add(event.id);
    await api<PublishResult>('POST', `/api/streams/${event.id}/publish`);
    await reportState(event.id, { state: 'live' });
    const test = await createTestStream('itest test beside an event');

    const lookup = await raw('GET', `/api/internal/streams/by-ingest/video/${test.topic}`, uploaderCall());

    assert.equal(lookup.status, 200, lookup.text);
    assert.equal((lookup.body as IngestLookupResponse).id, test.id);
  });

  it('answers concurrent quality reports in merge order', async () => {
    const stream = await createTestStream('itest concurrent reports');
    await reportState(stream.id, { state: 'live' });

    const rungs = [rung('360p', 360), rung('480p', 480), rung('720p', 720), rung('1080p', 1080)];
    const answers = await Promise.all(rungs.map((r) => reportRendition(stream.id, r)));

    const byOrder = [...answers].sort((a, b) => a.feed.index - b.feed.index);
    assert.deepEqual(
      byOrder.map((answer) => answer.feed.index),
      [2, 3, 4, 5],
    );
    for (let i = 1; i < byOrder.length; i++) {
      const earlier = byOrder[i - 1]!.renditions.map((r) => r.name);
      const later = new Set(byOrder[i]!.renditions.map((r) => r.name));
      assert.ok(
        earlier.every((name) => later.has(name)),
        `the answer numbered ${byOrder[i]!.feed.index} holds every rung of the one before it`,
      );
      assert.equal(later.size, earlier.length + 1);
    }
  });
});

describe("a test stream's viewer address", () => {
  it('is stored as given, answered on the stream, changed, and cleared by an empty one', async () => {
    const stream = await createTestStream('itest viewer address');
    const path = testStreamViewerUrlPath(stream.id);

    const set = await api<Stream>('PUT', path, { body: { url: 'http://203.0.113.7:10004/#/' } });
    assert.equal(set.viewerUrl, 'http://203.0.113.7:10004/#/');
    assert.equal((await api<Stream>('GET', `/api/streams/${stream.id}`)).viewerUrl, 'http://203.0.113.7:10004/#/');

    const changed = await api<Stream>('PUT', path, { body: { url: 'https://team.example.com/viewer' } });
    assert.equal(changed.viewerUrl, 'https://team.example.com/viewer');

    const cleared = await api<Stream>('PUT', path, { body: { url: '' } });
    assert.equal(cleared.viewerUrl, null);

    const audited = await pool.query<{ details: { viewerUrl: string | null; test: boolean } }>(
      `SELECT details FROM audit_log WHERE stream_id = $1 AND action = 'stream.viewer_url.set' ORDER BY id`,
      [stream.id],
    );
    assert.deepEqual(
      audited.rows.map((row) => row.details.viewerUrl),
      ['http://203.0.113.7:10004/#/', 'https://team.example.com/viewer', null],
    );
  });

  it('is taken while the test stream is a draft, live and recorded', async () => {
    const stream = await createTestStream('itest viewer address in every status');
    const path = testStreamViewerUrlPath(stream.id);

    assert.equal(
      (await api<Stream>('PUT', path, { body: { url: 'http://203.0.113.7:1' } })).viewerUrl,
      'http://203.0.113.7:1',
    );
    await reportState(stream.id, { state: 'live' });
    assert.equal(
      (await api<Stream>('PUT', path, { body: { url: 'http://203.0.113.7:2' } })).viewerUrl,
      'http://203.0.113.7:2',
    );
    await reportState(stream.id, { state: 'vod', index: 3, duration: 10 });
    assert.equal(
      (await api<Stream>('PUT', path, { body: { url: 'http://203.0.113.7:3' } })).viewerUrl,
      'http://203.0.113.7:3',
    );
  });

  it('is refused with its sentence when it is no http or https address', async () => {
    const stream = await createTestStream('itest bad viewer address');

    const refused = await raw('PUT', testStreamViewerUrlPath(stream.id), { body: { url: 'ftp://203.0.113.7/' } });

    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, { error: 'validation_error', errors: [viewerUrlProblem('ftp://203.0.113.7/')] });
  });

  it('is refused for a stream that is no test stream', async () => {
    const listed = await api<Stream>('POST', '/api/streams', {
      body: {
        title: 'itest no test stream',
        description: 'A stream that takes no viewer address.',
        tags: [],
        mediaType: 'video',
        scheduledStartTime: '2026-10-01T09:00:00.000Z',
        stageId: STAGE_ID,
      },
    });
    created.add(listed.id);

    const refused = await raw('PUT', testStreamViewerUrlPath(listed.id), { body: { url: 'http://203.0.113.7:10004' } });

    assert.equal(refused.status, 409);
    assert.equal((refused.body as { error: string }).error, NOT_TEST_STREAM_ERROR);
  });

  it('is refused without a session', async () => {
    const stream = await createTestStream('itest viewer address without a session');

    const refused = await raw('PUT', testStreamViewerUrlPath(stream.id), {
      body: { url: 'http://203.0.113.7:10004' },
      anonymous: true,
    });

    assert.equal(refused.status, 401);
  });
});
