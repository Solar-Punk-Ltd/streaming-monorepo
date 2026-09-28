/**
 * End-to-end tests against the RUNNING backend: the draft lifecycle from login
 * to delete, driven over HTTP exactly as the console drives it.
 *
 * Prerequisites (from apps/web2-admin/backend/):
 *
 *   pnpm database:start                     # Postgres on 127.0.0.1:5433
 *   pnpm test:integration
 *
 * The suite starts a backend of its own on a free port, against a throwaway
 * database, with FEED_GATEWAY=fake — see instance.ts. It never talks to the
 * development backend on :9877, which writes to a real Bee node and the real
 * catalogue. Everything it creates goes with the database in `after`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  FeedReconcileResult,
  IngestDetails,
  MeResponse,
  PublicConfig,
  PublishResult,
  Stream,
  StreamListResponse,
} from '@streaming-monorepo/web2-admin-common';
import { Pool } from 'pg';

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  api,
  cleanup,
  forgetCookie,
  login,
  PNG_1X1,
  raw,
  registerStage,
  releaseStack,
  requireStack,
  sessionCookie,
  stack,
} from './helpers.js';
import { SRT_PASSPHRASE, STAGE_ID } from '../unit/support/stageFakes.js';

const created = new Set<string>();

/** A second stage, registered where a test moves a stream to it. */
const SECOND_STAGE = '8c3f5d1b-4e5f-4061-9c73-3d4e5f607182';

const draft = {
  title: 'itest keynote',
  description: 'Created by the web2-admin integration suite.',
  tags: ['itest', 'swarm'],
  mediaType: 'video' as const,
  scheduledStartTime: '2026-10-01T09:00:00.000Z',
  // Registered in `before`: a draft with no stage is refused at publish.
  stageId: STAGE_ID,
};

before(async () => {
  await requireStack();
  await registerStage();
});
after(async () => {
  await login();
  await cleanup(created);
  await releaseStack();
});

describe('unauthenticated surface', () => {
  it('serves health without a session', async () => {
    const body = await api<{ status: string }>('GET', '/api/health', {
      anonymous: true,
    });
    assert.deepEqual(body, { status: 'ok' });
  });

  it('serves the public config: the feed anyone can read', async () => {
    const config = await api<PublicConfig>('GET', '/api/config', {
      anonymous: true,
    });
    assert.match(config.feed.owner, /^[0-9a-f]{40}$/);
    assert.match(config.feed.topicHex, /^[0-9a-f]{64}$/);
    assert.ok(config.feed.topic.length > 0);
  });

  it('refuses every stream route with 401 unauthenticated', async () => {
    const id = '1867808f-7b1c-4e46-b437-f7423b466b39';
    const calls: [string, string][] = [
      ['GET', '/api/streams'],
      ['POST', '/api/streams'],
      ['GET', `/api/streams/${id}`],
      ['PUT', `/api/streams/${id}`],
      ['DELETE', `/api/streams/${id}`],
      ['GET', `/api/streams/${id}/thumbnail`],
      ['PUT', `/api/streams/${id}/thumbnail`],
      ['POST', `/api/streams/${id}/publish`],
      ['POST', `/api/streams/${id}/unpublish`],
      ['GET', `/api/streams/${id}/ingest`],
      ['POST', `/api/streams/${id}/ingest/rotate-key`],
      // Not a stream route, but it rewrites the same feed, so it is behind the
      // same session.
      ['POST', '/api/feed/reconcile'],
      ['GET', '/api/auth/me'],
      ['POST', '/api/auth/password'],
    ];
    for (const [method, path] of calls) {
      const response = await raw(method, path, { anonymous: true });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.deepEqual(response.body, { error: 'unauthenticated' });
    }
  });

  it('treats a malformed session cookie as no session, not a 500', async () => {
    // A bare '%' is not valid percent-encoding. It used to throw URIError out
    // of the cookie parser, so every request — the logout that would clear the
    // cookie included — answered 500 and the console could not recover.
    for (const value of ['%', '%zz', 'abc%']) {
      const response = await raw('GET', '/api/auth/me', {
        anonymous: true,
        headers: { cookie: `web2_admin_session=${value}` },
      });
      assert.equal(response.status, 401, value);
      assert.deepEqual(response.body, { error: 'unauthenticated' });
    }

    const loggedOut = await raw('POST', '/api/auth/logout', {
      anonymous: true,
      headers: { cookie: 'web2_admin_session=%' },
    });
    assert.equal(loggedOut.status, 204, 'logout still clears it');
  });

  it('404s an unknown path with the path echoed back', async () => {
    const response = await raw('GET', '/api/nope', { anonymous: true });
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'not_found', path: '/api/nope' });
  });
});

describe('login', () => {
  it('refuses a wrong password without saying why', async () => {
    forgetCookie();
    const response = await raw('POST', '/api/auth/login', {
      body: { username: ADMIN_USERNAME, password: 'definitely-not-it' },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'invalid_credentials' });
    assert.equal(sessionCookie(), null);
  });

  it('rejects a malformed body as a validation error', async () => {
    const response = await raw('POST', '/api/auth/login', {
      body: { username: ADMIN_USERNAME },
    });
    assert.equal(response.status, 400);
    assert.equal((response.body as { error: string }).error, 'validation_error');
  });

  it('sets an httpOnly session cookie, and /auth/me reads it back', async () => {
    forgetCookie();
    const response = await raw('POST', '/api/auth/login', {
      body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    assert.equal(response.status, 200);

    const setCookie = response.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /^web2_admin_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\//i);

    const me = await api<MeResponse>('GET', '/api/auth/me');
    assert.equal(me.user.username, ADMIN_USERNAME);
    assert.equal((response.body as MeResponse).user.id, me.user.id);
  });
});

describe('stream lifecycle', () => {
  let stream: Stream;

  before(async () => {
    await login();
  });

  it('creates a draft, minting topic, owner and publish key', async () => {
    stream = await api<Stream>('POST', '/api/streams', { body: draft });
    created.add(stream.id);

    assert.equal(stream.status, 'draft');
    assert.equal(stream.title, draft.title);
    assert.deepEqual(stream.tags, draft.tags);
    assert.equal(stream.hasThumbnail, false);
    assert.equal(stream.thumbnailRef, null);
    assert.equal(stream.publishedAt, null);
    assert.equal(stream.publishedFeedIndex, null);
    assert.match(stream.topic, /^[0-9a-f-]{36}$/);

    const config = await api<PublicConfig>('GET', '/api/config');
    assert.equal(stream.owner, config.feed.owner, 'owner is the feed key');
  });

  it('puts the draft on the stage the form named', () => {
    assert.equal(stream.stageId, STAGE_ID);
  });

  it('rejects a body over the msrs-client limits', async () => {
    const response = await raw('POST', '/api/streams', {
      body: { ...draft, title: 'x'.repeat(101) },
    });
    assert.equal(response.status, 400);
    assert.equal((response.body as { error: string }).error, 'validation_error');
  });

  it('refuses a stream with no scheduled start time', async () => {
    // Without this rule the API can mint a row the console cannot edit: the
    // form will not submit an empty schedule, and the backend refuses any
    // other value once the stream has gone live.
    const { scheduledStartTime: _omitted, ...withoutSchedule } = draft;
    for (const body of [withoutSchedule, { ...draft, scheduledStartTime: null }]) {
      const created = await raw('POST', '/api/streams', { body });
      assert.equal(created.status, 400, JSON.stringify(body));
      assert.equal((created.body as { error: string }).error, 'validation_error');

      const updated = await raw('PUT', `/api/streams/${stream.id}`, { body });
      assert.equal(updated.status, 400, JSON.stringify(body));
      assert.equal((updated.body as { error: string }).error, 'validation_error');
    }
  });

  it('lists it, newest first', async () => {
    const list = await api<StreamListResponse>('GET', '/api/streams');
    assert.equal(list.streams[0]?.id, stream.id);
  });

  it('refuses to publish a draft with no stage, and publishes it once it has one', async () => {
    const stageless = await api<Stream>('POST', '/api/streams', { body: { ...draft, stageId: null } });
    created.add(stageless.id);

    const refused = await raw('POST', `/api/streams/${stageless.id}/publish`);
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, {
      error: 'stage_required',
      id: stageless.id,
      message: 'Pick the stage this stream is broadcast on before publishing.',
    });
    const details = await api<IngestDetails>('GET', `/api/streams/${stageless.id}/ingest`);
    assert.equal(details.stage, null);
    assert.equal(details.srt, null);

    await api<Stream>('PUT', `/api/streams/${stageless.id}`, { body: draft });
    const published = await api<PublishResult>('POST', `/api/streams/${stageless.id}/publish`);
    assert.equal(published.stream.status, 'published');
    await api<PublishResult>('POST', `/api/streams/${stageless.id}/unpublish`);
    assert.equal((await raw('DELETE', `/api/streams/${stageless.id}`)).status, 204);
    created.delete(stageless.id);
  });

  it('updates the draft', async () => {
    const updated = await api<Stream>('PUT', `/api/streams/${stream.id}`, {
      body: { ...draft, title: 'itest keynote, edited' },
    });
    assert.equal(updated.title, 'itest keynote, edited');
    assert.equal(updated.status, 'draft');
    assert.ok(updated.updatedAt >= stream.updatedAt);
    stream = updated;
  });

  it('changes the media type while it is a draft', async () => {
    const audio = await api<Stream>('PUT', `/api/streams/${stream.id}`, {
      body: { ...draft, mediaType: 'audio' },
    });
    assert.equal(audio.mediaType, 'audio');

    const back = await api<Stream>('PUT', `/api/streams/${stream.id}`, {
      body: { ...draft, title: 'itest keynote, edited' },
    });
    assert.equal(back.mediaType, 'video');
    stream = back;
  });

  it('stores a thumbnail and serves the bytes back', async () => {
    const withThumbnail = await api<Stream>('PUT', `/api/streams/${stream.id}/thumbnail`, {
      raw: PNG_1X1,
      contentType: 'image/png',
    });
    assert.equal(withThumbnail.hasThumbnail, true);
    assert.equal(withThumbnail.thumbnailRef, null, 'not uploaded to Swarm yet');

    const response = await raw('GET', `/api/streams/${stream.id}/thumbnail`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^image\/png/);
    assert.deepEqual(response.bytes, PNG_1X1, 'the bytes that were uploaded');
  });

  it('refuses a thumbnail that is not an image', async () => {
    const response = await raw('PUT', `/api/streams/${stream.id}/thumbnail`, {
      raw: Buffer.from('<html>nope</html>'),
      contentType: 'text/html',
    });
    assert.equal(response.status, 415);
    assert.equal((response.body as { error: string }).error, 'unsupported_media_type');
  });

  it('publishes: entry on the feed, thumbnail uploaded, status published', async () => {
    const result = await api<PublishResult>('POST', `/api/streams/${stream.id}/publish`);

    assert.equal(result.stream.status, 'published');
    assert.ok(result.stream.publishedAt);
    assert.equal(result.stream.publishedFeedIndex, result.feed.index);
    assert.equal(result.stream.publishError, null);
    assert.equal(result.stream.hasUnpublishedEdits, false, 'the edits made as a draft went out with the publish');
    assert.match(result.stream.thumbnailRef ?? '', /^[0-9a-f]{64}$/);
    assert.ok(result.feed.index >= 0);
    assert.ok(result.feed.entryCount >= 1);
    assert.match(result.feed.topicHex, /^[0-9a-f]{64}$/);
    stream = result.stream;
  });

  it('serves the OBS details for the published stream', async () => {
    const details = await api<IngestDetails>('GET', `/api/streams/${stream.id}/ingest`);
    assert.equal(details.app, 'video');
    assert.equal(details.stream, stream.topic);
    assert.equal(details.streamId, `video/${stream.topic}`);
    assert.match(details.publishKey, /^[0-9a-f]{32}$/);
    assert.equal(details.stage?.stageId, STAGE_ID, 'from the stage the stream is on');
    assert.ok(details.srt?.url.startsWith('srt://ingest.example.org:10061?'), 'at the address the manager pushed');
    assert.ok(details.srt?.url.includes(`r=video/${stream.topic}`));
    assert.ok(details.srt?.url.includes(`key=${details.publishKey}`));
    assert.equal(details.srt?.passphrase, SRT_PASSPHRASE, "the stage's own passphrase");
    assert.equal(details.rtmp, null, 'RTMP is offered only where the stage opens it');

    const rotated = await api<IngestDetails>('POST', `/api/streams/${stream.id}/ingest/rotate-key`);
    assert.notEqual(rotated.publishKey, details.publishKey);
    assert.match(rotated.publishKey, /^[0-9a-f]{32}$/);
    assert.ok(rotated.publishKeyRotatedAt);
  });

  it('refuses to delete a published stream', async () => {
    const response = await raw('DELETE', `/api/streams/${stream.id}`);
    assert.equal(response.status, 409);
    assert.equal((response.body as { error: string }).error, 'stream_published');
  });

  it('keeps a published stream published when it is edited', async () => {
    const updated = await api<Stream>('PUT', `/api/streams/${stream.id}`, {
      body: { ...draft, title: 'itest keynote, published edit' },
    });
    assert.equal(updated.status, 'published');
    assert.equal(updated.publishedFeedIndex, stream.publishedFeedIndex);
    assert.equal(updated.hasUnpublishedEdits, true, 'the entry on the feed still has the old title');
  });

  it('refuses a media type change while published', async () => {
    // It is the `app` half of the ingest stream id the streamer already has.
    const response = await raw('PUT', `/api/streams/${stream.id}`, {
      body: { ...draft, mediaType: 'audio' },
    });
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      error: 'media_type_locked',
      message: 'Unpublish the stream before changing its media type; it is part of the OBS stream id.',
    });

    const unchanged = await api<Stream>('GET', `/api/streams/${stream.id}`);
    assert.equal(unchanged.mediaType, 'video');
    assert.equal(unchanged.status, 'published');
  });

  it('refuses a stage change while published, and takes the stage it has', async () => {
    const second = await registerStage({ stageId: SECOND_STAGE, name: 'Second stage' });
    const response = await raw('PUT', `/api/streams/${stream.id}`, { body: { ...draft, stageId: second } });
    assert.equal(response.status, 409);
    assert.equal((response.body as { error: string; reason: string }).error, 'stage_locked');
    assert.equal((response.body as { error: string; reason: string }).reason, 'published');
    assert.equal((await api<Stream>('GET', `/api/streams/${stream.id}`)).stageId, STAGE_ID);
  });

  it('unpublishes: entry removed, stream back to draft', async () => {
    const result = await api<PublishResult>('POST', `/api/streams/${stream.id}/unpublish`);
    assert.equal(result.stream.status, 'draft');
    assert.equal(result.stream.publishedAt, null);
    assert.equal(result.stream.publishedFeedIndex, null);
    assert.ok(result.stream.thumbnailRef, 'the uploaded thumbnail is still paid for, so it is kept');
    stream = result.stream;
  });

  it('deletes the draft, and it is gone', async () => {
    const deleted = await raw('DELETE', `/api/streams/${stream.id}`);
    assert.equal(deleted.status, 204);
    created.delete(stream.id);

    const gone = await raw('GET', `/api/streams/${stream.id}`);
    assert.equal(gone.status, 404);
    assert.equal((gone.body as { error: string }).error, 'stream_not_found');
  });

  it('404s an unknown id and 400s a malformed one', async () => {
    const unknown = await raw('GET', '/api/streams/1867808f-7b1c-4e46-b437-f7423b466b39');
    assert.equal(unknown.status, 404);

    const malformed = await raw('GET', '/api/streams/not-a-uuid');
    assert.equal(malformed.status, 400);
    assert.equal((malformed.body as { error: string }).error, 'validation_error');
  });
});

/**
 * A stream belongs to the installation, not to whoever drafted it: every one
 * publishes to the same catalogue feed, signed by the installation's key.
 * Everything below is done by a second operator, a plain user made with the
 * CLI, on a stream the first operator drafted, through the routes the console
 * uses, and none of it is refused. The session still gates every one of them.
 */
describe('a second operator, on a stream the first one drafted', () => {
  const OPERATOR_USERNAME = 'itest-operator';
  const OPERATOR_PASSWORD = 'a-second-operators-password';
  let stream: Stream;

  before(async () => {
    await login();
    stream = await api<Stream>('POST', '/api/streams', {
      body: { ...draft, title: 'itest shared' },
    });
    created.add(stream.id);
    await stack().addUser(OPERATOR_USERNAME, OPERATOR_PASSWORD, false);
    await login(OPERATOR_USERNAME, OPERATOR_PASSWORD);
  });

  after(async () => {
    await login();
  });

  it('turns every one of these routes away without a session', async () => {
    const calls: [string, string][] = [
      ['GET', '/api/streams'],
      ['GET', `/api/streams/${stream.id}`],
      ['PUT', `/api/streams/${stream.id}`],
      ['DELETE', `/api/streams/${stream.id}`],
      ['GET', `/api/streams/${stream.id}/thumbnail`],
      ['PUT', `/api/streams/${stream.id}/thumbnail`],
      ['DELETE', `/api/streams/${stream.id}/thumbnail`],
      ['POST', `/api/streams/${stream.id}/publish`],
      ['POST', `/api/streams/${stream.id}/unpublish`],
      ['GET', `/api/streams/${stream.id}/ingest`],
      ['POST', `/api/streams/${stream.id}/ingest/rotate-key`],
      ['POST', '/api/feed/reconcile'],
    ];
    for (const [method, path] of calls) {
      const response = await raw(method, path, { anonymous: true });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.deepEqual(response.body, { error: 'unauthenticated' });
    }
  });

  it('sees it in the list, and opens it', async () => {
    const list = await api<StreamListResponse>('GET', '/api/streams');
    assert.ok(
      list.streams.some((s) => s.id === stream.id),
      'the list is the installation’s, not the caller’s',
    );

    const opened = await api<Stream>('GET', `/api/streams/${stream.id}`);
    assert.equal(opened.title, 'itest shared');
  });

  it('edits it', async () => {
    const edited = await api<Stream>('PUT', `/api/streams/${stream.id}`, {
      body: { ...draft, title: 'itest shared, edited by the second operator' },
    });
    assert.equal(edited.title, 'itest shared, edited by the second operator');
  });

  it('stores its thumbnail, serves it back and removes it', async () => {
    const stored = await api<Stream>('PUT', `/api/streams/${stream.id}/thumbnail`, {
      raw: PNG_1X1,
      contentType: 'image/png',
    });
    assert.equal(stored.hasThumbnail, true);

    const served = await raw('GET', `/api/streams/${stream.id}/thumbnail`);
    assert.equal(served.status, 200);
    assert.deepEqual(served.bytes, PNG_1X1);

    const removed = await api<Stream>('DELETE', `/api/streams/${stream.id}/thumbnail`);
    assert.equal(removed.hasThumbnail, false);
  });

  it('reads its OBS details and rotates its publish key', async () => {
    const details = await api<IngestDetails>('GET', `/api/streams/${stream.id}/ingest`);
    assert.equal(details.streamId, `video/${stream.topic}`);

    const rotated = await api<IngestDetails>('POST', `/api/streams/${stream.id}/ingest/rotate-key`);
    assert.notEqual(rotated.publishKey, details.publishKey);
  });

  it('publishes it, and unpublishes it', async () => {
    const published = await api<PublishResult>('POST', `/api/streams/${stream.id}/publish`);
    assert.equal(published.stream.status, 'published');

    const unpublished = await api<PublishResult>('POST', `/api/streams/${stream.id}/unpublish`);
    assert.equal(unpublished.stream.status, 'draft');
  });

  it('repairs its entry with a reconcile, after the first operator edited it on the catalogue', async () => {
    // An edit to a published stream leaves its entry saying what was
    // published: drift that a reconcile rebuilds from the row. The reconcile
    // used to rebuild only the streams of whoever ran it.
    await login();
    await api<PublishResult>('POST', `/api/streams/${stream.id}/publish`);
    const edited = await api<Stream>('PUT', `/api/streams/${stream.id}`, {
      body: { ...draft, title: 'itest shared, edited on the catalogue' },
    });
    assert.equal(edited.hasUnpublishedEdits, true);

    await login(OPERATOR_USERNAME, OPERATOR_PASSWORD);
    const reconciled = await api<FeedReconcileResult>('POST', '/api/feed/reconcile');
    assert.deepEqual(reconciled.updated, [stream.topic]);
    const repaired = await api<Stream>('GET', `/api/streams/${stream.id}`);
    assert.equal(repaired.hasUnpublishedEdits, false, 'the entry carries the edit now');

    const unpublished = await api<PublishResult>('POST', `/api/streams/${stream.id}/unpublish`);
    assert.equal(unpublished.stream.status, 'draft');
  });

  it('deletes it, and it is gone for the first operator too', async () => {
    const deleted = await raw('DELETE', `/api/streams/${stream.id}`);
    assert.equal(deleted.status, 204);
    created.delete(stream.id);

    await login();
    const gone = await raw('GET', `/api/streams/${stream.id}`);
    assert.equal(gone.status, 404);
    assert.equal((gone.body as { error: string }).error, 'stream_not_found');
  });

  it('left an audit row naming the second operator for each of those, the stream gone or not', async () => {
    // The one read of the database in this file: nothing in the API serves
    // the audit log yet, and it is the record of who did what here.
    const pool = new Pool({ connectionString: stack().databaseUrl });
    try {
      const rows = await pool.query<{ action: string; actor_kind: string; actor_user_id: string | null }>(
        `SELECT action, actor_kind, actor_user_id FROM audit_log
          WHERE stream_id = $1 AND actor_name = $2
          ORDER BY id`,
        [stream.id, OPERATOR_USERNAME],
      );
      assert.deepEqual(
        rows.rows.map((row) => row.action),
        [
          'stream.update',
          'stream.thumbnail.set',
          'stream.thumbnail.clear',
          'stream.key.rotate',
          'stream.publish',
          'stream.unpublish',
          'stream.unpublish',
          'stream.delete',
        ],
      );
      assert.ok(rows.rows.every((row) => row.actor_kind === 'operator' && row.actor_user_id !== null));

      const reconcile = await pool.query(
        `SELECT 1 FROM audit_log WHERE action = 'feed.reconcile' AND actor_name = $1`,
        [OPERATOR_USERNAME],
      );
      assert.equal(reconcile.rowCount, 1, 'the reconcile is the second operator’s too');
    } finally {
      await pool.end();
    }
  });
});

describe('logout', () => {
  it('clears the cookie and the session', async () => {
    await login();
    const response = await raw('POST', '/api/auth/logout');
    assert.equal(response.status, 204);
    assert.match(response.headers.get('set-cookie') ?? '', /^web2_admin_session=/);

    const after = await raw('GET', '/api/auth/me');
    assert.equal(after.status, 401);
  });
});
