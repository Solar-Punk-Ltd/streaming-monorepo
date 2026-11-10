import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  EXPORT_PATH,
  exportActionPath,
  exportFilePath,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  streamExportPath,
  type ExportCurrentResponse,
  type ExportOptionsResponse,
  type ExportSummary,
} from '@streaming-monorepo/web2-admin-common';
import express, { type RequestHandler } from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { createExportRouter } from '../../src/api/routes/exports.js';
import { createStreamsRouter } from '../../src/api/routes/streams.js';
import { ExportService } from '../../src/domain/export/ExportService.js';
import type { IngestService } from '../../src/domain/IngestService.js';
import type { PublishService } from '../../src/domain/PublishService.js';
import type { StreamFinishService } from '../../src/domain/StreamFinishService.js';
import type { StreamService } from '../../src/domain/StreamService.js';
import { userRow } from './support/authFixtures.js';
import {
  FakeJoiner,
  FakeRenditions,
  FakeSource,
  FakeStreams,
  InMemoryExportStore,
  playlistOf,
  ref,
} from './support/exportFakes.js';
import { InMemoryAuditLog, streamRow, TEST_OPERATOR } from './support/fakes.js';

/**
 * The export routes as the console calls them, over HTTP: the answers, the refusals, and the file as an attachment
 * with ranges. Sign-in is stood in for by a middleware that signs every request in as the test operator; the
 * service runs with Swarm and ffmpeg in memory.
 */

const streams = new FakeStreams();
const renditions = new FakeRenditions();
const store = new InMemoryExportStore(streams);
const source = new FakeSource();
const audit = new InMemoryAuditLog();
let dir: string;
let service: ExportService;
let server: http.Server;
let url: string;

const signedIn: RequestHandler = (req, _res, next) => {
  req.user = userRow({ id: TEST_OPERATOR.userId, username: TEST_OPERATOR.username });
  req.sessionTokenHash = 'test-session';
  next();
};

const recorded = streamRow({
  status: 'vod',
  manifest_index: 5,
  duration_seconds: 6,
  live_since: new Date('2026-11-05T09:30:00.000Z'),
  title: 'Opening keynote',
});
const live = streamRow({ status: 'live', title: 'On air' });

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'export-routes-test-'));
  streams.rows.set(recorded.id, recorded);
  streams.rows.set(live.id, live);
  const refs = [21, 22, 23].map(ref);
  source.playlist(recorded.topic, 5, playlistOf(refs));
  refs.forEach((reference, index) => source.segment(reference, `0123456789-${index}`));
  service = new ExportService(
    store,
    streams,
    renditions,
    { forRead: async () => ({ target: { beeApiUrl: 'http://node.test', batchId: 'b'.repeat(64) } }) },
    source,
    new FakeJoiner(),
    audit,
    { dir, parallelReads: 2, retryDelaysMs: [], disk: { space: async () => ({ free: 1e12, total: 1e12 }) } },
  );

  const app = express();
  app.use(requireSameSite);
  app.use(express.json());
  app.use(
    '/api/streams',
    createStreamsRouter({
      streamService: {} as StreamService,
      publishService: {} as PublishService,
      ingestService: {} as IngestService,
      streamFinishService: {} as StreamFinishService,
      exportService: service,
      requireAuth: signedIn,
    }),
  );
  app.use(EXPORT_PATH, createExportRouter({ exportService: service, requireAuth: signedIn }));
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
  await rm(dir, { recursive: true, force: true });
});

function post(route: string, body: unknown): Promise<Response> {
  return fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE },
    body: JSON.stringify(body),
  });
}

describe('the export routes', () => {
  it('answer no export before one starts, never cached', async () => {
    const res = await fetch(`${url}${EXPORT_PATH}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await res.json()) as ExportCurrentResponse, { export: null });
  });

  it('refuse a stream that is live, with the sentence, and a body that names no quality', async () => {
    const refused = await post(streamExportPath(live.id), { rendition: 'source' });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), {
      error: 'export_refused',
      problem: 'not_recording',
      message: 'Only a finished recording can be exported, and this stream is live now.',
    });

    const malformed = await post(streamExportPath(recorded.id), { rendition: '../etc' });
    assert.equal(malformed.status, 400);
  });

  it('offer the qualities, start an export, and send the MP4 as an attachment with ranges', async () => {
    const options = (await (await fetch(`${url}${streamExportPath(recorded.id)}`)).json()) as ExportOptionsResponse;
    assert.deepEqual(
      options.qualities.map((quality) => quality.rendition),
      ['source'],
    );

    const started = await post(streamExportPath(recorded.id), { rendition: 'source' });
    assert.equal(started.status, 201);
    const { id } = (await started.json()) as ExportSummary;
    await service.settled();

    const current = ((await (await fetch(`${url}${EXPORT_PATH}`)).json()) as ExportCurrentResponse).export;
    assert.equal(current?.state, 'done');
    assert.equal(current?.fileName, 'opening-keynote-2026-11-05-720p.mp4');

    const file = await fetch(`${url}${exportFilePath(id)}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-disposition'), 'attachment; filename="opening-keynote-2026-11-05-720p.mp4"');
    assert.equal(file.headers.get('content-type'), 'video/mp4');
    assert.equal(file.headers.get('x-accel-buffering'), 'no');
    assert.equal((await file.text()).length, current?.sizeBytes);

    const resumed = await fetch(`${url}${exportFilePath(id)}`, { headers: { range: 'bytes=2-5' } });
    assert.equal(resumed.status, 206);
    assert.equal(await resumed.text(), '2345');
    // The save is audited once: a resumed download asks for the rest of the same save.
    assert.equal(audit.withAction('export.file').length, 1);
  });

  it('refuse an action the export is not in a state for, an unknown action, and an export that is gone', async () => {
    const current = ((await (await fetch(`${url}${EXPORT_PATH}`)).json()) as ExportCurrentResponse).export!;

    const notNow = await post(exportActionPath(current.id), { action: 'pause' });
    assert.equal(notNow.status, 409);
    assert.equal(((await notNow.json()) as { problem: string }).problem, 'not_now');

    assert.equal((await post(exportActionPath(current.id), { action: 'jump' })).status, 400);

    const gone = await post(exportActionPath('11111111-2222-4333-8444-555555555555'), { action: 'cancel' });
    assert.equal(gone.status, 404);
    assert.equal(((await gone.json()) as { error: string }).error, 'export_not_found');
    assert.equal((await fetch(`${url}${exportFilePath('11111111-2222-4333-8444-555555555555')}`)).status, 404);
  });

  it('refuse a write from another site, as every write of the console is', async () => {
    const res = await fetch(`${url}${streamExportPath(recorded.id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rendition: 'source' }),
    });
    assert.equal(res.status, 403);
  });
});
