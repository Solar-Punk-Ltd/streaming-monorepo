/**
 * End-to-end tests against the RUNNING backend: the draft lifecycle from login
 * to delete, driven over HTTP exactly as the console drives it.
 *
 * Prerequisites (from web2-admin/backend/):
 *
 *   pnpm database:start                     # Postgres on 127.0.0.1:5433
 *   FEED_GATEWAY=fake pnpm dev              # API on :9877
 *   pnpm test:integration
 *
 * FEED_GATEWAY=fake matters: the publish steps expect feed writes to succeed
 * without a Bee node or a usable postage batch. Against FEED_GATEWAY=bee they
 * assert the real thing and will fail if Swarm is not reachable.
 *
 * Point elsewhere with WEB2_ADMIN_URL, and at another login with
 * ADMIN_USERNAME / ADMIN_PASSWORD. Everything created is removed in `after`,
 * including after a failed test; nothing else is touched.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  IngestDetails,
  MeResponse,
  PublicConfig,
  PublishResult,
  Stream,
  StreamListResponse,
} from '@streaming-monorepo/web2-admin-common';

import {
  api,
  cleanup,
  forgetCookie,
  login,
  PNG_1X1,
  raw,
  requireStack,
  sessionCookie,
} from './helpers.js';

const created = new Set<string>();

const draft = {
  title: 'itest keynote',
  description: 'Created by the web2-admin integration suite.',
  tags: ['itest', 'swarm'],
  mediaType: 'video' as const,
  scheduledStartTime: '2026-10-01T09:00:00.000Z',
};

before(requireStack);
after(async () => {
  await login();
  await cleanup(created);
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
      body: { username: 'admin', password: 'definitely-not-it' },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'invalid_credentials' });
    assert.equal(sessionCookie(), null);
  });

  it('rejects a malformed body as a validation error', async () => {
    const response = await raw('POST', '/api/auth/login', {
      body: { username: 'admin' },
    });
    assert.equal(response.status, 400);
    assert.equal((response.body as { error: string }).error, 'validation_error');
  });

  it('does not throttle usernames that do not exist', async () => {
    // Nothing to guess behind them, and remembering them is how the throttle's
    // memory would be filled for free. The 11th attempt used to be a 429.
    forgetCookie();
    const username = `itest-nobody-${Date.now()}`;
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      const response = await raw('POST', '/api/auth/login', {
        body: { username, password: 'x' },
      });
      assert.equal(response.status, 401, `attempt ${attempt}`);
      assert.deepEqual(response.body, { error: 'invalid_credentials' });
    }
  });

  it('sets an httpOnly session cookie, and /auth/me reads it back', async () => {
    forgetCookie();
    const response = await raw('POST', '/api/auth/login', {
      body: { username: 'admin', password: process.env.ADMIN_PASSWORD ?? 'admin1234' },
    });
    assert.equal(response.status, 200);

    const setCookie = response.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /^web2_admin_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\//i);

    const me = await api<MeResponse>('GET', '/api/auth/me');
    assert.equal(me.user.username, 'admin');
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

  it('rejects a body over the msrs-client limits', async () => {
    const response = await raw('POST', '/api/streams', {
      body: { ...draft, title: 'x'.repeat(101) },
    });
    assert.equal(response.status, 400);
    assert.equal((response.body as { error: string }).error, 'validation_error');
  });

  it('lists it, newest first', async () => {
    const list = await api<StreamListResponse>('GET', '/api/streams');
    assert.equal(list.streams[0]?.id, stream.id);
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
    const withThumbnail = await api<Stream>(
      'PUT',
      `/api/streams/${stream.id}/thumbnail`,
      { raw: PNG_1X1, contentType: 'image/png' },
    );
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
    assert.equal(
      (response.body as { error: string }).error,
      'unsupported_media_type',
    );
  });

  it('publishes: entry on the feed, thumbnail uploaded, status published', async () => {
    const result = await api<PublishResult>(
      'POST',
      `/api/streams/${stream.id}/publish`,
    );

    assert.equal(result.stream.status, 'published');
    assert.ok(result.stream.publishedAt);
    assert.equal(result.stream.publishedFeedIndex, result.feed.index);
    assert.equal(result.stream.publishError, null);
    assert.match(result.stream.thumbnailRef ?? '', /^[0-9a-f]{64}$/);
    assert.ok(result.feed.index >= 0);
    assert.ok(result.feed.entryCount >= 1);
    assert.match(result.feed.topicHex, /^[0-9a-f]{64}$/);
    stream = result.stream;
  });

  it('serves the OBS details for the published stream', async () => {
    const details = await api<IngestDetails>(
      'GET',
      `/api/streams/${stream.id}/ingest`,
    );
    assert.equal(details.app, 'video');
    assert.equal(details.stream, stream.topic);
    assert.equal(details.streamId, `video/${stream.topic}`);
    assert.match(details.publishKey, /^[0-9a-f]{32}$/);
    assert.ok(details.srt.url.includes(`r=video/${stream.topic}`));
    assert.ok(details.srt.url.includes(`key=${details.publishKey}`));
    assert.ok(details.rtmp.server.endsWith('/video'));
    assert.equal(
      details.rtmp.streamKey,
      `${stream.topic}?key=${details.publishKey}`,
    );

    const rotated = await api<IngestDetails>(
      'POST',
      `/api/streams/${stream.id}/ingest/rotate-key`,
    );
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
  });

  it('refuses a media type change while published', async () => {
    // It is the `app` half of the ingest stream id the streamer already has.
    const response = await raw('PUT', `/api/streams/${stream.id}`, {
      body: { ...draft, mediaType: 'audio' },
    });
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      error: 'media_type_locked',
      message:
        'Unpublish the stream before changing its media type; it is part of the OBS stream id.',
    });

    const unchanged = await api<Stream>('GET', `/api/streams/${stream.id}`);
    assert.equal(unchanged.mediaType, 'video');
    assert.equal(unchanged.status, 'published');
  });

  it('unpublishes: entry removed, stream back to draft', async () => {
    const result = await api<PublishResult>(
      'POST',
      `/api/streams/${stream.id}/unpublish`,
    );
    assert.equal(result.stream.status, 'draft');
    assert.equal(result.stream.publishedAt, null);
    assert.equal(result.stream.publishedFeedIndex, null);
    assert.ok(
      result.stream.thumbnailRef,
      'the uploaded thumbnail is still paid for, so it is kept',
    );
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
    const unknown = await raw(
      'GET',
      '/api/streams/1867808f-7b1c-4e46-b437-f7423b466b39',
    );
    assert.equal(unknown.status, 404);

    const malformed = await raw('GET', '/api/streams/not-a-uuid');
    assert.equal(malformed.status, 400);
    assert.equal(
      (malformed.body as { error: string }).error,
      'validation_error',
    );
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
