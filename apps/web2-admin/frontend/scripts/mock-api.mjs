#!/usr/bin/env node
/**
 * A throwaway in-memory stand-in for the web2-admin backend, for UI work when
 * the real API (and its Postgres and Bee) are not running. It implements the
 * checkpoint-2 contract closely enough to click through every screen: cookie
 * sessions, the seeded admin user, stream CRUD, thumbnails, publish/unpublish
 * against a fake feed, and the ingest details.
 *
 * It is NOT the contract and never validates like yup does. Point the console
 * at it with these, from apps/web2-admin:
 *
 *   node frontend/scripts/mock-api.mjs
 *   VITE_WEB2_ADMIN_URL=http://localhost:9877 pnpm --filter @streaming-monorepo/web2-admin-frontend dev
 *
 * MOCK_NO_USERS=true starts with an empty users table, which is the only way
 * to see the console's "no users yet" screen and the command it prints.
 *
 * MOCK_RECORDING=true starts with one finished recording on the feed, which is
 * the only way to see the recording's details and to unpublish and publish it
 * again, since nothing here can broadcast.
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

// Flip to true to see the OBS panel of a deployment that opened RTMP ingest.
// Off, as on the API, the panel offers SRT only.
const RTMP_PUBLIC = process.env.INGEST_RTMP_PUBLIC === 'true';

const OWNER = '1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c';
const FEED_TOPIC = 'swarm-stream';
const FEED_TOPIC_HEX = '4c4b1a0d9e5b1f7a3c2d8e6f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3';

/**
 * The users the mock knows. `MOCK_NO_USERS=true` starts with none, which is
 * the only way to see the console's "no users yet" screen and the command it
 * prints.
 */
const users = new Map();
const passwords = new Map();

function makeUser(username, password, isAdmin) {
  const row = {
    id: randomUUID(),
    username,
    isAdmin,
    createdAt: new Date().toISOString(),
    passwordChangedAt: null,
    lastLoginAt: null,
  };
  users.set(row.id, row);
  passwords.set(row.id, password);
  return row;
}

if (process.env.MOCK_NO_USERS !== 'true') {
  makeUser(SEED_USERNAME, seedPassword, true);
}

function byUsername(username) {
  return [...users.values()].find((u) => u.username === username) ?? null;
}

/** username -> consecutive failures, for the lockout the real API keeps. */
const failures = new Map();
const LOCKOUT_FREE_ATTEMPTS = 4;
const LOCKOUT_SECONDS = 60;

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

/** The signed-in user, or null. */
function currentUser(req) {
  const token = readCookie(req);
  if (token === null) return null;
  return users.get(sessions.get(token)) ?? null;
}

function sessionCount(userId) {
  return [...sessions.values()].filter((id) => id === userId).length;
}

function summarise(row) {
  return {
    id: row.id,
    username: row.username,
    isAdmin: row.isAdmin,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    sessions: sessionCount(row.id),
  };
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

/** The statuses whose stream has an entry on the catalogue. */
const ON_FEED_STATUSES = ['published', 'live', 'vod'];

function publicStream(row) {
  const { thumbnail, thumbnailMime, editsNotOnFeed, ...rest } = row;
  return {
    ...rest,
    hasThumbnail: thumbnail !== null && thumbnailMime !== null,
    hasUnpublishedEdits: editsNotOnFeed && ON_FEED_STATUSES.includes(row.status),
  };
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
    rtmp: RTMP_PUBLIC
      ? {
          server: `rtmp://ingest.example.test:10062/${row.mediaType}`,
          streamKey: `${row.topic}?key=${row.publishKey}`,
        }
      : null,
    keyVerified: KEY_VERIFIED,
  };
}

/** What the catalogue entry carries of a stream's own fields. */
function entryContent(row) {
  return JSON.stringify([row.title, row.description, row.tags, row.mediaType, row.scheduledStartTime]);
}

/**
 * Like the API, a save that changes nothing is not an edit: the console PUTs
 * the whole form back every time.
 */
function applyInput(row, input) {
  const before = entryContent(row);
  row.title = String(input.title ?? '');
  row.description = String(input.description ?? '');
  row.tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
  row.mediaType = input.mediaType === 'audio' ? 'audio' : 'video';
  row.scheduledStartTime = input.scheduledStartTime ?? null;
  row.updatedAt = new Date().toISOString();
  if (entryContent(row) !== before) row.editsNotOnFeed = true;
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
    // What the uploader reports. Only the MOCK_RECORDING seed sets them.
    manifestIndex: null,
    durationSeconds: null,
    liveSince: null,
    endedAt: null,
    // Stands in for the API's two timestamps: an edit the catalogue entry
    // does not carry yet. Cleared by a publish, which rebuilds the entry.
    editsNotOnFeed: false,
    createdAt: now,
    updatedAt: now,
  };
  applyInput(row, input);
  row.editsNotOnFeed = false;
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

if (process.env.MOCK_RECORDING === 'true') {
  const row = newStream({
    title: 'A finished broadcast',
    description: 'Seeded by MOCK_RECORDING: a recording already on the feed.',
    tags: ['mock'],
    mediaType: 'video',
    scheduledStartTime: '2026-09-11T10:00:00.000Z',
  });
  feedIndex += 1;
  feedEntries += 1;
  Object.assign(row, {
    status: 'vod',
    publishedAt: '2026-09-11T09:00:00.000Z',
    publishedFeedIndex: feedIndex,
    manifestIndex: 412,
    durationSeconds: 3540,
    liveSince: '2026-09-11T10:01:00.000Z',
    endedAt: '2026-09-11T11:00:00.000Z',
  });
  streams.set(row.id, row);
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

  // Every write must carry the header no cross-origin page can add without a
  // preflight this mock, like the API, never answers.
  if (method !== 'GET' && method !== 'HEAD' && req.headers['x-requested-with'] !== 'web2-admin') {
    return send(res, 403, { error: 'cross_site_request' });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readJson(req);
    if (users.size === 0) return send(res, 401, { error: 'no_users' });

    const name = String(body.username ?? '');
    if ((failures.get(name) ?? 0) > LOCKOUT_FREE_ATTEMPTS) {
      return send(
        res,
        429,
        { error: 'too_many_attempts', retryAfterSeconds: LOCKOUT_SECONDS },
        { 'retry-after': String(LOCKOUT_SECONDS) },
      );
    }

    const row = byUsername(name);
    if (row === null || passwords.get(row.id) !== body.password) {
      failures.set(name, (failures.get(name) ?? 0) + 1);
      return send(res, 401, { error: 'invalid_credentials' });
    }

    failures.delete(name);
    row.lastLoginAt = new Date().toISOString();
    const token = hex(24);
    sessions.set(token, row.id);
    return send(
      res,
      200,
      { user: row },
      {
        'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
      },
    );
  }

  // Public: the console asks this on boot, and a 401 here is an answer.
  if (path === '/api/auth/session') {
    const me = currentUser(req);
    if (me) return send(res, 200, { user: me });
    return send(res, 401, {
      error: users.size === 0 ? 'no_users' : 'unauthenticated',
    });
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
  const user = currentUser(req);
  if (user === null) return send(res, 401, { error: 'unauthenticated' });

  if (path === '/api/auth/users' && method === 'GET') {
    return send(res, 200, { users: [...users.values()].map(summarise) });
  }

  if (path === '/api/auth/users' && method === 'POST') {
    if (!user.isAdmin) return send(res, 403, { error: 'admin_required' });
    const body = await readJson(req);
    if (byUsername(body.username)) {
      return send(res, 409, { error: 'user_exists' });
    }
    const added = makeUser(String(body.username), String(body.password), body.admin === true);
    return send(res, 201, { user: added });
  }

  const userRoute = /^\/api\/auth\/users\/([^/]+)(\/revoke)?$/.exec(path);
  if (userRoute) {
    const target = users.get(userRoute[1]);
    if (!target) return send(res, 404, { error: 'user_not_found' });

    if (userRoute[2] && method === 'POST') {
      if (!user.isAdmin && target.id !== user.id) {
        return send(res, 403, { error: 'admin_required' });
      }
      for (const [token, id] of [...sessions.entries()]) {
        if (id === target.id) sessions.delete(token);
      }
      res.writeHead(204);
      return res.end();
    }

    if (!userRoute[2] && method === 'DELETE') {
      if (!user.isAdmin) return send(res, 403, { error: 'admin_required' });
      const admins = [...users.values()].filter((u) => u.isAdmin).length;
      if (target.id === user.id || users.size <= 1 || (target.isAdmin && admins <= 1)) {
        return send(res, 409, { error: 'cannot_remove_user' });
      }
      users.delete(target.id);
      passwords.delete(target.id);
      for (const [token, id] of [...sessions.entries()]) {
        if (id === target.id) sessions.delete(token);
      }
      res.writeHead(204);
      return res.end();
    }
  }

  if (path === '/api/auth/password' && method === 'POST') {
    const body = await readJson(req);
    if (passwords.get(user.id) !== body.currentPassword) {
      return send(res, 401, { error: 'invalid_credentials' });
    }
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 12) {
      return send(res, 400, {
        error: 'validation_error',
        errors: ['password must be at least 12 characters'],
      });
    }
    passwords.set(user.id, body.newPassword);
    if (user.username === SEED_USERNAME) seedPassword = body.newPassword;
    user.passwordChangedAt = new Date().toISOString();
    // Every other session of this user goes away; keep the caller's.
    const keep = readCookie(req);
    for (const [token, id] of [...sessions.entries()]) {
      if (id === user.id && token !== keep) sessions.delete(token);
    }
    return send(res, 200, { user });
  }

  // No manager pushes into the mock, so it has no stages and no catalogue
  // stamp: the Stages page shows its empty state.
  if (path === '/api/stages' && method === 'GET') return send(res, 200, { stages: [] });
  if (path === '/api/catalogue-stamp' && method === 'GET') return send(res, 200, { catalogueStamp: null });

  if (path === '/api/streams' && method === 'GET') {
    const list = [...streams.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicStream);
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
    if (row.status === 'live') return send(res, 409, { error: 'stream_live' });
    if (ON_FEED_STATUSES.includes(row.status)) {
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
    row.editsNotOnFeed = true;
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
    if (row.thumbnail) row.editsNotOnFeed = true;
    row.thumbnail = null;
    row.thumbnailMime = null;
    row.thumbnailRef = null;
    row.updatedAt = new Date().toISOString();
    return send(res, 200, publicStream(row));
  }

  if (sub === '/publish' && method === 'POST') {
    if (row.status === 'publishing') {
      return send(res, 409, { error: 'stream_busy' });
    }
    if (!ON_FEED_STATUSES.includes(row.status)) feedEntries += 1;
    feedIndex += 1;
    if (row.thumbnail && !row.thumbnailRef) row.thumbnailRef = hex(32);
    const now = new Date().toISOString();
    // Like the API: a live or recorded stream keeps its state, and a draft
    // that still holds a recording goes back on the feed as that recording.
    if (row.status === 'draft' || row.status === 'published') {
      row.status = row.manifestIndex !== null ? 'vod' : 'published';
      row.publishedAt = now;
    }
    row.publishedFeedIndex = feedIndex;
    row.publishError = null;
    row.editsNotOnFeed = false;
    row.updatedAt = now;
    return send(res, 200, publishResult(row));
  }

  if (sub === '/unpublish' && method === 'POST') {
    if (row.status === 'live') return send(res, 409, { error: 'stream_live' });
    if (ON_FEED_STATUSES.includes(row.status)) {
      feedEntries = Math.max(0, feedEntries - 1);
      feedIndex += 1;
    }
    // Off the feed and back to a draft, keeping the recording, as the API does.
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
  console.log(`[mock-api] INGEST_RTMP_PUBLIC=${RTMP_PUBLIC}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
