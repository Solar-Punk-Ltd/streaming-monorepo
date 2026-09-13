#!/usr/bin/env node
/**
 * A throwaway in-memory stand-in for the web2-admin backend, for UI work when
 * the real API (and its Postgres and Bee) are not running. It implements the
 * checkpoint-2 contract closely enough to click through every screen: cookie
 * sessions, the seeded admin user, stream CRUD, thumbnails, publish/unpublish
 * against a fake feed, and the ingest details.
 *
 * It is NOT the contract and never validates like yup does. Point the console
 * at it with:
 *
 *   node web2-admin/frontend/scripts/mock-api.mjs
 *   VITE_WEB2_ADMIN_URL=http://localhost:9877 pnpm --filter @streaming-monorepo/web2-admin-frontend dev
 *
 * No dependencies: plain node:http, plain node:crypto.
 */

import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

const PORT = Number(process.env.MOCK_API_PORT ?? 9877);
const COOKIE = 'web2_admin_session';

const SEED_USERNAME = process.env.SEED_ADMIN_USERNAME ?? 'admin';
let seedPassword = process.env.SEED_ADMIN_PASSWORD ?? 'admin1234';

// Flip to true to exercise the "ingest verifies the key" branch of the OBS panel.
const KEY_VERIFIED = process.env.INGEST_KEY_VERIFIED === 'true';

const OWNER = '1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c';
const FEED_TOPIC = 'swarm-stream';
const FEED_TOPIC_HEX =
  '4c4b1a0d9e5b1f7a3c2d8e6f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3';

const user = {
  id: randomUUID(),
  username: SEED_USERNAME,
  createdAt: new Date().toISOString(),
  passwordChangedAt: null,
};

/** token -> userId */
const sessions = new Map();
/** id -> stream row (plus the thumbnail bytes, which the API never returns) */
const streams = new Map();
let feedIndex = -1;
let feedEntries = 0;

function hex(bytes) {
  return randomBytes(bytes).toString('hex');
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function readCookie(req) {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

function authed(req) {
  const token = readCookie(req);
  return token !== null && sessions.has(token);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return {};
  }
}

function publicStream(row) {
  const { thumbnail, thumbnailMime, ...rest } = row;
  return { ...rest, hasThumbnail: thumbnail !== null && thumbnailMime !== null };
}

function ingestDetails(row) {
  const streamId = `${row.mediaType}/${row.topic}`;
  return {
    streamId,
    app: row.mediaType,
    stream: row.topic,
    publishKey: row.publishKey,
    publishKeyRotatedAt: row.publishKeyRotatedAt,
    srt: {
      url: `srt://ingest.example.test:10061?streamid=#!::r=${streamId}?key=${row.publishKey},m=publish`,
      passphrase: 'mock-srt-passphrase-value',
    },
    rtmp: {
      server: `rtmp://ingest.example.test:10062/${row.mediaType}`,
      streamKey: `${row.topic}?key=${row.publishKey}`,
    },
    keyVerified: KEY_VERIFIED,
  };
}

function applyInput(row, input) {
  row.title = String(input.title ?? '');
  row.description = String(input.description ?? '');
  row.tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
  row.mediaType = input.mediaType === 'audio' ? 'audio' : 'video';
  row.scheduledStartTime = input.scheduledStartTime ?? null;
  row.updatedAt = new Date().toISOString();
}

function newStream(input) {
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    topic: randomUUID(),
    owner: OWNER,
    title: '',
    description: '',
    tags: [],
    mediaType: 'video',
    scheduledStartTime: null,
    thumbnail: null,
    thumbnailMime: null,
    thumbnailRef: null,
    status: 'draft',
    publishedAt: null,
    publishedFeedIndex: null,
    publishError: null,
    publishKey: hex(16),
    publishKeyRotatedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  applyInput(row, input);
  return row;
}

function publishResult(row) {
  return {
    stream: publicStream(row),
    feed: {
      owner: OWNER,
      topic: FEED_TOPIC,
      topicHex: FEED_TOPIC_HEX,
      index: feedIndex,
      entryCount: feedEntries,
    },
  };
}

const server = createServer((req, res) => {
  void handle(req, res).catch((e) => {
    send(res, 500, { error: 'internal_error', message: String(e) });
  });
});

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/api/health') return send(res, 200, { status: 'ok' });

  if (path === '/api/config') {
    return send(res, 200, {
      feed: { owner: OWNER, topic: FEED_TOPIC, topicHex: FEED_TOPIC_HEX },
      viewerBaseUrl: process.env.VIEWER_BASE_URL ?? 'http://localhost:10074',
    });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readJson(req);
    if (body.username !== user.username || body.password !== seedPassword) {
      return send(res, 401, { error: 'invalid_credentials' });
    }
    const token = hex(24);
    sessions.set(token, user.id);
    return send(
      res,
      200,
      { user },
      {
        'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
      },
    );
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    const token = readCookie(req);
    if (token) sessions.delete(token);
    res.writeHead(204, {
      'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    });
    return res.end();
  }

  // Everything below needs a session.
  if (!authed(req)) return send(res, 401, { error: 'unauthenticated' });

  if (path === '/api/auth/me') return send(res, 200, { user });

  if (path === '/api/auth/password' && method === 'POST') {
    const body = await readJson(req);
    if (body.currentPassword !== seedPassword) {
      return send(res, 400, { error: 'invalid_password' });
    }
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 8) {
      return send(res, 400, {
        error: 'validation_error',
        errors: ['newPassword must be at least 8 characters'],
      });
    }
    seedPassword = body.newPassword;
    user.passwordChangedAt = new Date().toISOString();
    // Every other session of this user goes away; keep the caller's.
    const keep = readCookie(req);
    for (const token of [...sessions.keys()]) {
      if (token !== keep) sessions.delete(token);
    }
    return send(res, 200, { user });
  }

  if (path === '/api/streams' && method === 'GET') {
    const list = [...streams.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicStream);
    return send(res, 200, { streams: list });
  }

  if (path === '/api/streams' && method === 'POST') {
    const row = newStream(await readJson(req));
    streams.set(row.id, row);
    return send(res, 201, publicStream(row));
  }

  const match = /^\/api\/streams\/([^/]+)(\/.*)?$/.exec(path);
  if (!match) return send(res, 404, { error: 'not_found', path });

  const row = streams.get(match[1]);
  if (!row) return send(res, 404, { error: 'not_found', path });
  const sub = match[2] ?? '';

  if (sub === '' && method === 'GET') return send(res, 200, publicStream(row));

  if (sub === '' && method === 'PUT') {
    if (row.status === 'publishing') return send(res, 409, { error: 'stream_busy' });
    applyInput(row, await readJson(req));
    return send(res, 200, publicStream(row));
  }

  if (sub === '' && method === 'DELETE') {
    if (row.status === 'published') {
      return send(res, 409, { error: 'stream_published' });
    }
    streams.delete(row.id);
    res.writeHead(204);
    return res.end();
  }

  if (sub === '/thumbnail' && method === 'PUT') {
    const mime = String(req.headers['content-type'] ?? '');
    if (!mime.startsWith('image/')) {
      return send(res, 415, { error: 'unsupported_media_type' });
    }
    const bytes = await readBody(req);
    if (bytes.length > 5 * 1024 * 1024) {
      return send(res, 413, { error: 'payload_too_large' });
    }
    row.thumbnail = bytes;
    row.thumbnailMime = mime;
    // A new image invalidates whatever was uploaded to Swarm before.
    row.thumbnailRef = null;
    row.updatedAt = new Date().toISOString();
    return send(res, 200, publicStream(row));
  }

  if (sub === '/thumbnail' && method === 'GET') {
    if (!row.thumbnail) return send(res, 404, { error: 'not_found', path });
    res.writeHead(200, {
      'content-type': row.thumbnailMime,
      'content-length': row.thumbnail.length,
      'cache-control': 'no-cache',
    });
    return res.end(row.thumbnail);
  }

  if (sub === '/thumbnail' && method === 'DELETE') {
    row.thumbnail = null;
    row.thumbnailMime = null;
    row.thumbnailRef = null;
    row.updatedAt = new Date().toISOString();
    return send(res, 200, publicStream(row));
  }

  if (sub === '/publish' && method === 'POST') {
    if (row.status !== 'draft' && row.status !== 'published') {
      return send(res, 409, { error: 'stream_busy' });
    }
    const wasPublished = row.status === 'published';
    if (!wasPublished) feedEntries += 1;
    feedIndex += 1;
    if (row.thumbnail && !row.thumbnailRef) row.thumbnailRef = hex(32);
    row.status = 'published';
    row.publishedAt = new Date().toISOString();
    row.publishedFeedIndex = feedIndex;
    row.publishError = null;
    row.updatedAt = row.publishedAt;
    return send(res, 200, publishResult(row));
  }

  if (sub === '/unpublish' && method === 'POST') {
    if (row.status === 'published') {
      feedEntries = Math.max(0, feedEntries - 1);
      feedIndex += 1;
    }
    row.status = 'draft';
    row.publishedAt = null;
    row.publishedFeedIndex = null;
    row.updatedAt = new Date().toISOString();
    return send(res, 200, publishResult(row));
  }

  if (sub === '/ingest' && method === 'GET') {
    return send(res, 200, ingestDetails(row));
  }

  if (sub === '/ingest/rotate-key' && method === 'POST') {
    row.publishKey = hex(16);
    row.publishKeyRotatedAt = new Date().toISOString();
    row.updatedAt = row.publishKeyRotatedAt;
    return send(res, 200, ingestDetails(row));
  }

  return send(res, 404, { error: 'not_found', path });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-api] listening on http://127.0.0.1:${PORT}`);
  console.log(`[mock-api] log in as ${SEED_USERNAME} / ${seedPassword}`);
  console.log(`[mock-api] INGEST_KEY_VERIFIED=${KEY_VERIFIED}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
