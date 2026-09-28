/**
 * A token per uploader (docs/architecture/stages.md, phases 5 and 9). Unit test: the real internal router, both
 * doors and the real services on a random port, mounted the way `src/api/server.ts` mounts them, with the stores, the
 * feed log and the audit log in memory. `pnpm test`.
 *
 * Pinned here:
 * - the manager's routes and `GET /registrar` take the registrar token alone, and refuse a stage's own token;
 * - the uploader's routes take an active stage's own token alone. They refuse the registrar token, on every route and
 *   whether or not a `shared` stage record names its hash, with the same 401 `unauthenticated` as any other token,
 *   and write nothing for it. They refuse a retired stage's token, the hash a `shared` row carries, a token no stage
 *   names, one several stages name, a missing or malformed header and a session cookie;
 * - a stage's token is answered only about its stage's streams: another stage's stream, and a stream with no stage,
 *   are the same 404 as a stream that does not exist, with nothing written;
 * - `GET /stages/self` names the caller's stage and owner, and is 401 on the registrar token;
 * - the registrar token is refused before any lookup, even when a stage row names it as its `own` token, and a push
 *   that names it as a stage's own is refused and stores nothing;
 * - no token and no token hash reaches a log line, and a refused registrar token logs nothing.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import type { StageRecord } from '@streaming-monorepo/contracts';
import type { Request, Response } from 'express';
import express from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { notFound } from '../../src/api/middleware/notFound.js';
import { createRequireInternalToken } from '../../src/api/middleware/requireInternalToken.js';
import { createRequireUploaderToken } from '../../src/api/middleware/requireUploaderToken.js';
import { createInternalRouter } from '../../src/api/routes/internal.js';
import { UnauthenticatedError } from '../../src/domain/errors/index.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import { LadderService } from '../../src/domain/LadderService.js';
import { PublishService } from '../../src/domain/PublishService.js';
import { splitStageRecord, StageService } from '../../src/domain/StageService.js';
import { StreamStateService } from '../../src/domain/StreamStateService.js';
import type { StreamRow } from '../../src/types/index.js';

import {
  FakeFeedWriteLog,
  FakeRenditionStore,
  FakeStreamStore,
  InMemoryAuditLog,
  noCatalogueStamp,
  streamRow,
  TEST_OPERATOR,
  TEST_OWNER,
} from './support/fakes.js';
import { FakeCatalogueStampStore, FakeStageStore, STAGE_ID, STAGE_OWNER, stageRecord } from './support/stageFakes.js';

const sha256 = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * `INTERNAL_API_TOKEN`, the registrar token: 64 hex characters, as the env file's sample generates one, so it has the
 * shape of a stage's own token and the uploader's door does ask the database for it, and still refuses it.
 */
const REGISTRAR = 'ab'.repeat(32);
/** The own token of `STAGE_ID`, the main stage: 64 hex characters, as the manager generates one. */
const MAIN_TOKEN = 'a1'.repeat(32);
const OTHER_TOKEN = 'b2'.repeat(32);
const RETIRED_TOKEN = 'c3'.repeat(32);
/**
 * A registrar token the admin no longer holds, which a `shared` row still names by its hash: a deployment still on
 * an old copy after the link's token changed. Hex, so the admin does ask for it, and refuses it.
 */
const OLD_SHARED = 'd4'.repeat(32);
/** One own token two stages were pushed with. */
const TWICE_TOKEN = 'e5'.repeat(32);
const UNKNOWN_TOKEN = 'f6'.repeat(32);

const EVERY_TOKEN = [REGISTRAR, MAIN_TOKEN, OTHER_TOKEN, RETIRED_TOKEN, OLD_SHARED, TWICE_TOKEN, UNKNOWN_TOKEN];

const OTHER_ID = '6a1d3b9f-2c3d-4e5f-8a51-1b2c3d4e5f60';
const OTHER_OWNER = '0x' + '4b'.repeat(20);
const RETIRED_ID = '7b2e4c0a-3d4e-4f60-9b62-2c3d4e5f6071';
const SHARED_ROW_ID = '8c3f5d1b-4e5f-4071-8c73-3d4e5f607182';
/** A stage still on a copy of the current registrar token, which an older manager copied into it: it must rotate. */
const COPIED_ROW_ID = 'bf628a4e-7182-43a4-9fa6-60718293a4b5';
/**
 * A row that names the registrar token as its `own`, which no push can store any more (the service refuses it) but a
 * database written before that could hold: the door still refuses the token, without asking.
 */
const REGISTRAR_AS_OWN_ID = 'c0739b5f-8293-44b5-8a06-718293a4b5c6';
const TWICE_IDS = ['9d406e2c-5f60-4182-9d84-4e5f60718293', 'ae517f3d-6071-4293-8e95-5f60718293a4'];

let server: http.Server;
let url: string;
let stages: FakeStageStore;
let streams: FakeStreamStore;
let renditions: FakeRenditionStore;
let feedWrites: FakeFeedWriteLog;
let audit: InMemoryAuditLog;

let onMain: StreamRow;
let onOther: StreamRow;
let noStage: StreamRow;

/** Every line logged during a test, at any level. */
const lines: string[] = [];
let restoreConsole: (() => void) | null = null;

function ownStage(stageId: string, name: string, token: string, over: Partial<StageRecord> = {}): StageRecord {
  return stageRecord({ stageId, name, adminToken: { sha256: sha256(token), kind: 'own' }, ...over });
}

before(async () => {
  stages = new FakeStageStore();
  for (const record of [
    ownStage(STAGE_ID, 'Main stage', MAIN_TOKEN),
    ownStage(OTHER_ID, 'Other stage', OTHER_TOKEN, { owner: OTHER_OWNER }),
    ownStage(RETIRED_ID, 'Retired stage', RETIRED_TOKEN),
    stageRecord({
      stageId: SHARED_ROW_ID,
      name: 'Shared stage',
      adminToken: { sha256: sha256(OLD_SHARED), kind: 'shared' },
    }),
    stageRecord({
      stageId: COPIED_ROW_ID,
      name: 'Copied stage',
      adminToken: { sha256: sha256(REGISTRAR), kind: 'shared' },
    }),
    ownStage(TWICE_IDS[0]!, 'Twice stage A', TWICE_TOKEN),
    ownStage(TWICE_IDS[1]!, 'Twice stage B', TWICE_TOKEN),
    ownStage(REGISTRAR_AS_OWN_ID, 'Registrar stage', REGISTRAR),
  ]) {
    await stages.upsert(splitStageRecord(record));
  }
  await stages.retire(RETIRED_ID, '2026-09-28T10:05:00.000Z');

  audit = new InMemoryAuditLog();
  renditions = new FakeRenditionStore();
  streams = new FakeStreamStore(renditions);
  feedWrites = new FakeFeedWriteLog();
  const feed = { owner: TEST_OWNER, topic: 'swarm-stream', topicHex: '00'.repeat(32) };
  const publishService = new PublishService(
    streams,
    renditions,
    stages,
    feedWrites,
    new FakeFeedGateway(),
    noCatalogueStamp(),
    feed,
    audit,
  );

  onMain = streams.add(streamRow({ title: 'On the main stage', stage_id: STAGE_ID }));
  onOther = streams.add(streamRow({ title: 'On the other stage', stage_id: OTHER_ID }));
  noStage = streams.add(streamRow({ title: 'On no stage', stage_id: STAGE_ID }));
  for (const stream of [onMain, onOther, noStage]) await publishService.publish(TEST_OPERATOR, stream.id);
  // A stream published before stages existed: on the catalogue, with no stage.
  streams.rows.set(noStage.id, { ...streams.get(noStage.id), stage_id: null });

  const app = express();
  app.use(
    '/api/internal',
    express.json(),
    createInternalRouter({
      streamStateService: new StreamStateService(streams, publishService, audit),
      ladderService: new LadderService(streams, renditions, publishService, audit),
      stageService: new StageService(stages, new FakeCatalogueStampStore(), audit, { registrarToken: REGISTRAR }),
      requireRegistrarToken: createRequireInternalToken(REGISTRAR),
      requireUploaderToken: createRequireUploaderToken({ registrarToken: REGISTRAR, stages }),
    }),
  );
  app.use(notFound);
  app.use(errorHandler);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not report a port');
  url = `http://127.0.0.1:${address.port}`;
});

after(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
);

beforeEach(() => {
  lines.length = 0;
  const keep = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  const methods = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => mock.method(console, name, keep));
  restoreConsole = () => methods.forEach((method) => method.mock.restore());
});

afterEach(() => {
  restoreConsole?.();
  restoreConsole = null;
  const everything = lines.join('\n');
  for (const token of EVERY_TOKEN) {
    assert.equal(everything.includes(token), false, 'a token reached a log line');
    assert.equal(everything.includes(sha256(token)), false, 'a token hash reached a log line');
  }
});

interface Answer {
  status: number;
  text: string;
  body: unknown;
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null; authorization?: string; cookie?: string } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? REGISTRAR : options.token;
  if (options.authorization !== undefined) headers.authorization = options.authorization;
  else if (token !== null) headers.authorization = `Bearer ${token}`;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${url}/api/internal${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? (JSON.parse(text) as unknown) : undefined };
}

const lookup = (stream: StreamRow, token: string | null) =>
  call('GET', `/streams/by-ingest/${stream.media_type}/${stream.topic}`, { token });

/** One call on each uploader route, for a stream, with bodies the contract takes. */
function uploaderCalls(stream: StreamRow): [string, string, unknown][] {
  return [
    ['GET', `/streams/by-ingest/${stream.media_type}/${stream.topic}`, undefined],
    ['POST', `/streams/${stream.id}/state`, { state: 'live' }],
    [
      'POST',
      `/streams/${stream.id}/renditions`,
      {
        name: '720p',
        width: 1280,
        height: 720,
        topic: 'bbbbbbbb-0000-4000-8000-000000000720',
        bandwidth: 2_880_000,
        avgBandwidth: 2_160_000,
      },
    ],
    ['GET', '/stages/self', undefined],
  ];
}

/** What a call could have written: the rows, the rungs, the feed log and the audit log. */
function written(): string {
  return JSON.stringify({
    rows: [...streams.rows.values()].map((row) => [row.id, row.status, row.live_since]),
    rungs: [...renditions.rows.entries()],
    feed: feedWrites.records.length,
    audit: audit.entries.length,
  });
}

const GONE = { observedAt: '2026-09-28T10:05:00.000Z' };

describe('the manager’s routes', () => {
  it('take the registrar token, and refuse a stage’s own token and every other one', async () => {
    const requests: [string, string, unknown][] = [
      ['PUT', `/stages/${STAGE_ID}`, ownStage(STAGE_ID, 'Main stage', MAIN_TOKEN)],
      ['DELETE', `/stages/${TWICE_IDS[0]}`, { observedAt: '2026-09-28T09:00:00.000Z' }],
      ['PUT', '/catalogue-stamp', undefined],
      ['DELETE', '/catalogue-stamp', GONE],
    ];
    for (const [method, path, body] of requests) {
      for (const token of [MAIN_TOKEN, OTHER_TOKEN, RETIRED_TOKEN, OLD_SHARED, TWICE_TOKEN, UNKNOWN_TOKEN, null]) {
        const answer = await call(method, path, { body, token });
        assert.equal(answer.status, 401, `${method} ${path} took ${token === null ? 'no token' : 'a wrong one'}`);
        assert.deepEqual(answer.body, { error: 'unauthenticated' });
      }
    }

    const stored = await call('PUT', `/stages/${STAGE_ID}`, { body: ownStage(STAGE_ID, 'Main stage', MAIN_TOKEN) });
    assert.equal(stored.status, 200, stored.text);
    assert.deepEqual(stored.body, { stored: true });
  });

  it('answer the registrar check 204 on the registrar token, with no body, and 401 on any other', async () => {
    const checked = await call('GET', '/registrar', { token: REGISTRAR });
    assert.equal(checked.status, 204);
    assert.equal(checked.text, '');

    for (const token of [MAIN_TOKEN, OTHER_TOKEN, OLD_SHARED, UNKNOWN_TOKEN, null]) {
      const answer = await call('GET', '/registrar', { token });
      assert.equal(answer.status, 401, `the registrar check took ${token === null ? 'no token' : 'a wrong one'}`);
      assert.deepEqual(answer.body, { error: 'unauthenticated' });
    }
    // Only GET: another method is an unknown path, which the registrar token reads as a 404.
    assert.equal((await call('POST', '/registrar', { token: REGISTRAR })).status, 404);
  });
});

describe('the uploader’s routes', () => {
  it('refuse the registrar token on every route, for every stream, and write nothing', async () => {
    const before = written();
    for (const stream of [onMain, onOther, noStage]) {
      for (const [method, path, body] of uploaderCalls(stream)) {
        const answer = await call(method, path, { body, token: REGISTRAR });
        assert.equal(answer.status, 401, `${method} ${path} took the registrar token`);
        assert.deepEqual(answer.body, { error: 'unauthenticated' });
      }
    }
    assert.equal(written(), before, 'a call on the registrar token wrote something');
    assert.deepEqual(lines, [], 'a refused registrar token is not logged');
  });

  it('take an active stage’s own token, answered about its own streams', async () => {
    const answer = await lookup(onMain, MAIN_TOKEN);
    assert.equal(answer.status, 200, answer.text);
    assert.equal((answer.body as { id: string }).id, onMain.id);

    const other = await lookup(onOther, OTHER_TOKEN);
    assert.equal(other.status, 200, other.text);
    assert.equal((other.body as { id: string }).id, onOther.id);

    // Surrounding whitespace is read as the registrar's door reads it.
    const padded = await call('GET', `/streams/by-ingest/video/${onMain.topic}`, {
      authorization: `Bearer ${MAIN_TOKEN}  `,
    });
    assert.equal(padded.status, 200, padded.text);
  });

  it('refuse a retired stage’s token, a shared row’s old token, an unknown one, and a missing or malformed header', async () => {
    const refusals: { token?: string | null; authorization?: string; cookie?: string }[] = [
      { token: RETIRED_TOKEN },
      { token: OLD_SHARED },
      { token: UNKNOWN_TOKEN },
      { token: `${MAIN_TOKEN}x` },
      { token: MAIN_TOKEN.toUpperCase() },
      { token: sha256(MAIN_TOKEN) },
      { token: null },
      { authorization: '' },
      { authorization: 'Bearer' },
      { authorization: 'Bearer    ' },
      { authorization: MAIN_TOKEN },
      { authorization: `Basic ${MAIN_TOKEN}` },
      { token: null, cookie: 'web2_admin_session=a-console-session' },
    ];
    const before = written();
    for (const stream of [onMain, noStage]) {
      for (const [method, path, body] of uploaderCalls(stream)) {
        for (const options of refusals) {
          const answer = await call(method, path, { body, ...options });
          assert.equal(answer.status, 401, `${method} ${path} with ${JSON.stringify(options)}`);
          assert.deepEqual(answer.body, { error: 'unauthenticated' });
        }
      }
    }
    assert.equal(written(), before, 'a refused call wrote something');
  });

  it('refuse a token several stages were pushed with, and say so without the token', async () => {
    const before = written();
    for (const [method, path, body] of uploaderCalls(onMain)) {
      const answer = await call(method, path, { body, token: TWICE_TOKEN });
      assert.equal(answer.status, 401, `${method} ${path}`);
    }
    assert.equal(written(), before);

    const warnings = lines.filter((line) => line.includes('[WARN]') && line.includes('several active stages'));
    assert.equal(warnings.length, 4);
    assert.match(warnings[0]!, /"Twice stage A" \(stage 9d406e2c-/);
    assert.match(warnings[0]!, /"Twice stage B" \(stage ae517f3d-/);
  });

  it('answer an unknown path 401 without a token, and 404 with either', async () => {
    assert.equal((await call('GET', '/nothing-here', { token: null })).status, 401);
    assert.equal((await call('GET', `/stages/${STAGE_ID}`, { token: null })).status, 401);
    for (const token of [REGISTRAR, MAIN_TOKEN]) {
      const answer = await call('GET', '/nothing-here', { token });
      assert.equal(answer.status, 404);
      assert.deepEqual(answer.body, { error: 'not_found', path: '/api/internal/nothing-here' });
    }
  });
});

describe('a stage’s token is scoped to its stage', () => {
  it('finds no stream of another stage, nor one with no stage', async () => {
    for (const stream of [onOther, noStage]) {
      const answer = await lookup(stream, MAIN_TOKEN);
      assert.equal(answer.status, 404, stream.title);
      assert.deepEqual(answer.body, { error: 'stream_not_found', id: `video/${stream.topic}` });
    }
    const unknown = await call('GET', '/streams/by-ingest/video/1867808f-7b1c-4e46-b437-f7423b466b39', {
      token: MAIN_TOKEN,
    });
    assert.deepEqual(
      (await lookup(onOther, MAIN_TOKEN)).body,
      { ...(unknown.body as object), id: `video/${onOther.topic}` },
      'another stage’s stream reads exactly as one that does not exist',
    );
  });

  it('takes no state or rendition report for them, and writes nothing', async () => {
    const before = written();
    for (const stream of [onOther, noStage]) {
      for (const [method, path, body] of uploaderCalls(stream).slice(1, 3)) {
        const answer = await call(method, path, { body, token: MAIN_TOKEN });
        assert.equal(answer.status, 404, `${method} ${path}`);
        assert.deepEqual(answer.body, { error: 'stream_not_found', id: stream.id });
      }
    }
    assert.equal(written(), before, 'an out-of-scope report wrote something');
    assert.equal(streams.get(onOther.id).status, 'published');
    assert.equal(streams.get(noStage.id).status, 'published');
  });

  it('takes the reports of its own stage’s streams', async () => {
    const [, state, rendition] = uploaderCalls(onMain);
    const live = await call(state![0], state![1], { body: state![2], token: MAIN_TOKEN });
    assert.equal(live.status, 200, live.text);
    assert.equal(streams.get(onMain.id).status, 'live');

    const rung = await call(rendition![0], rendition![1], { body: rendition![2], token: MAIN_TOKEN });
    assert.equal(rung.status, 200, rung.text);
    assert.equal(renditions.rows.get(onMain.id)?.length, 1);
  });
});

describe('GET /stages/self', () => {
  it('names the stage a stage’s own token is on, and the owner it signs as', async () => {
    const main = await call('GET', '/stages/self', { token: MAIN_TOKEN });
    assert.equal(main.status, 200, main.text);
    assert.deepEqual(main.body, { stageId: STAGE_ID, owner: STAGE_OWNER });

    const other = await call('GET', '/stages/self', { token: OTHER_TOKEN });
    assert.deepEqual(other.body, { stageId: OTHER_ID, owner: OTHER_OWNER });
  });

  it('is 401 on the registrar token, which belongs to no stage and is the manager’s alone', async () => {
    const answer = await call('GET', '/stages/self', { token: REGISTRAR });
    assert.equal(answer.status, 401);
    assert.deepEqual(answer.body, { error: 'unauthenticated' });
  });

  it('is 401 on a retired stage’s token and without one', async () => {
    assert.equal((await call('GET', '/stages/self', { token: RETIRED_TOKEN })).status, 401);
    assert.equal((await call('GET', '/stages/self', { token: null })).status, 401);
  });
});

describe('the registrar token as a stage’s own', () => {
  it('is refused on a push, which stores nothing and answers 400 without the token or its hash', async () => {
    const pushed = ownStage('d1840c6a-93a4-45c6-9b17-8293a4b5c6d7', 'Pushed with the registrar token', REGISTRAR);
    const before = JSON.stringify([...stages.rows.keys()]);
    const answer = await call('PUT', `/stages/${pushed.stageId}`, { body: pushed });
    assert.equal(answer.status, 400, answer.text);
    assert.equal(answer.text.includes(sha256(REGISTRAR)), false);
    assert.match(answer.text, /registrar token/);
    assert.equal(JSON.stringify([...stages.rows.keys()]), before, 'the record was stored');
    assert.ok(lines.some((line) => line.includes('[WARN]') && line.includes('registrar token as its own')));
  });

  it('still stores a record that names the registrar token as shared, which the door refuses anyway', async () => {
    const copied = stageRecord({
      stageId: COPIED_ROW_ID,
      name: 'Copied stage',
      observedAt: '2026-09-28T11:00:00.000Z',
      adminToken: { sha256: sha256(REGISTRAR), kind: 'shared' },
    });
    const answer = await call('PUT', `/stages/${COPIED_ROW_ID}`, { body: copied });
    assert.equal(answer.status, 200, answer.text);
  });

  it('is refused on every uploader route even where a stored row names it as its own', async () => {
    for (const [method, path, body] of uploaderCalls(onMain)) {
      const answer = await call(method, path, { body, token: REGISTRAR });
      assert.equal(answer.status, 401, `${method} ${path}`);
    }
  });
});

describe('requireUploaderToken on its own', () => {
  function run(store: { findActiveByOwnTokenSha256(sha256: string): Promise<never[]> }): Promise<unknown> {
    const door = createRequireUploaderToken({ registrarToken: REGISTRAR, stages: store });
    const req = {
      get: (name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${MAIN_TOKEN}` : undefined),
    } as unknown as Request;
    return new Promise((resolve) => door(req, {} as Response, ((err?: unknown) => resolve(err ?? null)) as never));
  }

  it('hands a failed lookup to the error handler, once', async () => {
    const failure = new Error('connection lost');
    assert.equal(await run({ findActiveByOwnTokenSha256: () => Promise.reject(failure) }), failure);
  });

  it('refuses a token no stage names as unauthenticated', async () => {
    assert.ok((await run({ findActiveByOwnTokenSha256: async () => [] })) instanceof UnauthenticatedError);
  });

  it('asks the database only for a token of 64 hex characters, and refuses anything else without a query', async () => {
    let lookups = 0;
    const store = {
      findActiveByOwnTokenSha256: async () => {
        lookups += 1;
        return [] as never[];
      },
    };
    const door = createRequireUploaderToken({ registrarToken: REGISTRAR, stages: store });
    const ask = (token: string) =>
      new Promise((resolve) =>
        door(
          { get: (name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined) } as never,
          {} as Response,
          ((err?: unknown) => resolve(err ?? null)) as never,
        ),
      );
    for (const guess of ['short', `${MAIN_TOKEN}0`, MAIN_TOKEN.slice(1), `${'g'.repeat(64)}`, 'x'.repeat(40)]) {
      assert.ok((await ask(guess)) instanceof UnauthenticatedError, guess);
    }
    assert.equal(lookups, 0, 'no guess of another shape reached the database');
    assert.ok((await ask(UNKNOWN_TOKEN)) instanceof UnauthenticatedError);
    assert.equal(lookups, 1);
    // The registrar token has the shape of an own token, and is refused without a query.
    assert.ok((await ask(REGISTRAR)) instanceof UnauthenticatedError);
    assert.ok((await ask(`${REGISTRAR}  `)) instanceof UnauthenticatedError);
    assert.equal(lookups, 1, 'the registrar token reached the database');
  });
});
