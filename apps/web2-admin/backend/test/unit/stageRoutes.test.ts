/**
 * The manager's stage routes under /api/internal and the console's two reads of what it pushed. Unit test: the real
 * routers, token check and session gate on a random port, mounted the way `src/api/server.ts` mounts them, with the
 * stores and the audit log in memory. `pnpm test`.
 *
 * Pinned here: the manager's routes answer the registrar token and nothing else, a session cookie included; a body
 * the contract refuses and a path that names another stage are 400; and the SRT passphrase and the token hash never
 * reach an answer, the console's or the manager's, nor a log line, whatever the request.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import {
  SESSION_COOKIE_NAME,
  type CatalogueStampResponse,
  type StageListResponse,
} from '@streaming-monorepo/web2-admin-common';
import express from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { notFound } from '../../src/api/middleware/notFound.js';
import { createRequireAuth } from '../../src/api/middleware/requireAuth.js';
import { createRequireInternalToken } from '../../src/api/middleware/requireInternalToken.js';
import { createRequireUploaderToken } from '../../src/api/middleware/requireUploaderToken.js';
import { createInternalRouter } from '../../src/api/routes/internal.js';
import { createCatalogueStampRouter, createStagesRouter } from '../../src/api/routes/stages.js';
import { AuthService } from '../../src/domain/auth/AuthService.js';
import { CatalogueBatchService } from '../../src/domain/CatalogueBatch.js';
import { LadderService } from '../../src/domain/LadderService.js';
import { StageService } from '../../src/domain/StageService.js';
import { StreamStateService } from '../../src/domain/StreamStateService.js';
import { PublishService } from '../../src/domain/PublishService.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';

import {
  InMemoryCredentialRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  TEST_SETUP,
} from './support/authFixtures.js';
import {
  FakeFeedWriteLog,
  FakeRenditionStore,
  FakeStreamStore,
  InMemoryAuditLog,
  noCatalogueStamp,
  TEST_OWNER,
} from './support/fakes.js';
import {
  catalogueStampRecord,
  FakeCatalogueStampStore,
  FakeStageStore,
  SRT_PASSPHRASE,
  STAGE_ID,
  stageRecord,
  TOKEN_SHA256,
} from './support/stageFakes.js';

const TOKEN = 'test-registrar-token-000000000000000000';
const PASSWORD = 'a-long-enough-password';

let server: http.Server;
let url: string;
let cookie: string;
let stages: FakeStageStore;
let catalogue: FakeCatalogueStampStore;
let audit: InMemoryAuditLog;

/** Every line logged during a test, at any level, so a test can prove a secret never reached one. */
const lines: string[] = [];
let restoreConsole: (() => void) | null = null;

before(async () => {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  audit = new InMemoryAuditLog();
  const auth = new AuthService(users, sessions, new InMemoryCredentialRepository(users, sessions), audit);
  await auth.addUser(TEST_SETUP, 'alice', PASSWORD);
  const { token } = await auth.signIn({ username: 'alice', password: PASSWORD, ip: '127.0.0.1', userAgent: null });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;

  stages = new FakeStageStore();
  catalogue = new FakeCatalogueStampStore();
  const stageService = new StageService(stages, catalogue, audit);

  // The uploader's routes share the router; they are wired so it is the real one, and never called here.
  const renditions = new FakeRenditionStore();
  const streams = new FakeStreamStore(renditions);
  const feed = { owner: TEST_OWNER, topic: 'swarm-stream', topicHex: '00'.repeat(32) };
  const publishService = new PublishService(
    streams,
    renditions,
    stages,
    new FakeFeedWriteLog(),
    new FakeFeedGateway(),
    noCatalogueStamp(),
    feed,
    audit,
  );

  const requireAuth = createRequireAuth(auth);
  const app = express();
  app.use(
    '/api/internal',
    express.json(),
    createInternalRouter({
      streamStateService: new StreamStateService(streams, publishService, audit),
      ladderService: new LadderService(streams, renditions, publishService, audit),
      stageService,
      requireRegistrarToken: createRequireInternalToken(TOKEN),
      requireUploaderToken: createRequireUploaderToken({ sharedToken: TOKEN, stages }),
    }),
  );
  app.use(express.json());
  app.use('/api/stages', createStagesRouter({ stageService, requireAuth }));
  const catalogueBatch = new CatalogueBatchService(catalogue, new FakeFeedWriteLog(), feed, audit, {
    stampRequired: true,
  });
  app.use('/api/catalogue-stamp', createCatalogueStampRouter({ stageService, catalogueBatch, requireAuth }));
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
  stages.rows.clear();
  stages.tombstones.clear();
  catalogue.row = null;
  audit.entries.length = 0;
  lines.length = 0;
  const keep = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  const methods = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => mock.method(console, name, keep));
  restoreConsole = () => methods.forEach((method) => method.mock.restore());
});

afterEach(() => {
  restoreConsole?.();
  restoreConsole = null;
  const everything = lines.join('\n');
  assert.equal(everything.includes(SRT_PASSPHRASE), false, 'the passphrase reached a log line');
  assert.equal(everything.includes(TOKEN_SHA256), false, 'the token hash reached a log line');
});

interface Answer {
  status: number;
  text: string;
  body: unknown;
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null; cookie?: string } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${url}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? (JSON.parse(text) as unknown) : undefined };
}

const stagePath = `/api/internal/stages/${STAGE_ID}`;

/** A DELETE body: the moment the manager saw the deployment, or the designation, gone. */
const GONE = { observedAt: '2026-09-28T10:05:00.000Z' };

function assertNoSecret(answer: Answer): void {
  assert.equal(answer.text.includes(SRT_PASSPHRASE), false, 'the passphrase reached an answer');
  assert.equal(answer.text.includes(TOKEN_SHA256), false, 'the token hash reached an answer');
}

describe('the manager’s stage routes', () => {
  it('refuse a request without the token, with a wrong one, and with a session cookie instead', async () => {
    const requests: [string, string, unknown][] = [
      ['PUT', stagePath, stageRecord()],
      ['DELETE', stagePath, GONE],
      ['PUT', '/api/internal/catalogue-stamp', catalogueStampRecord()],
      ['DELETE', '/api/internal/catalogue-stamp', GONE],
    ];
    for (const [method, path, body] of requests) {
      for (const options of [{ token: null }, { token: `${TOKEN}x` }, { token: null, cookie }]) {
        const answer = await call(method, path, { body, ...options });
        assert.equal(answer.status, 401, `${method} ${path} with ${JSON.stringify(options)}`);
        assert.deepEqual(answer.body, { error: 'unauthenticated' });
      }
    }
    assert.equal(stages.rows.size, 0);
    assert.equal(catalogue.row, null);
  });

  it('store a stage record and answer whether it was stored', async () => {
    const answer = await call('PUT', stagePath, { body: stageRecord() });

    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { stored: true });
    assertNoSecret(answer);
    assert.equal(stages.rows.get(STAGE_ID)?.srt_passphrase, SRT_PASSPHRASE);

    const older = await call('PUT', stagePath, { body: stageRecord({ observedAt: '2026-09-28T09:59:00.000Z' }) });
    assert.deepEqual(older.body, { stored: false });
  });

  it('take a stage id printed in upper case as the same stage', async () => {
    const answer = await call('PUT', `/api/internal/stages/${STAGE_ID.toUpperCase()}`, {
      body: stageRecord({ stageId: STAGE_ID.toUpperCase() }),
    });

    assert.deepEqual(answer.body, { stored: true });
    assert.deepEqual([...stages.rows.keys()], [STAGE_ID]);
  });

  it('refuse a path that names another stage than the record', async () => {
    const answer = await call('PUT', '/api/internal/stages/ffffffff-ffff-4fff-8fff-ffffffffffff', {
      body: stageRecord(),
    });

    assert.equal(answer.status, 400);
    assert.deepEqual(answer.body, {
      error: 'validation_error',
      errors: ['the stage id in the path must equal stageId in the body'],
    });
    assertNoSecret(answer);
    assert.equal(stages.rows.size, 0);
  });

  it('refuse a stage id that is not a UUID', async () => {
    for (const [method, body] of [
      ['PUT', stageRecord()],
      ['DELETE', GONE],
    ] as const) {
      const answer = await call(method, '/api/internal/stages/self', { body });
      assert.equal(answer.status, 400, method);
      assert.deepEqual(answer.body, { error: 'validation_error', errors: ['stageId must be a UUID'] });
    }
  });

  it('refuse a body the contract refuses, without echoing any of it', async () => {
    const bodies: unknown[] = [
      { ...stageRecord(), schemaVersion: 2 },
      { ...stageRecord(), engine: 'nginx' },
      { ...stageRecord(), ingest: { ...stageRecord().ingest, host: 'srt://ingest.example.org:10061' } },
      { ...stageRecord(), ingest: { ...stageRecord().ingest, srtPort: 0 } },
      { ...stageRecord(), owner: 'not-an-address', observedAt: 'yesterday' },
      { ...stageRecord(), adminToken: { sha256: 'short', kind: 'own' } },
      {},
    ];
    for (const body of bodies) {
      const answer = await call('PUT', stagePath, { body });
      assert.equal(answer.status, 400, JSON.stringify(answer.body));
      assert.equal((answer.body as { error: string }).error, 'validation_error');
      assertNoSecret(answer);
      assert.equal(answer.text.includes('ingest.example.org'), false, 'the answer echoes the body');
    }
    assert.equal(stages.rows.size, 0);
    assert.equal(audit.entries.length, 0);
  });

  it('refuse a body that is not JSON', async () => {
    const res = await fetch(`${url}${stagePath}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: `{"srtPassphrase":"${SRT_PASSPHRASE}"`,
    });
    const text = await res.text();

    assert.equal(res.status, 400);
    assert.equal(text.includes(SRT_PASSPHRASE), false);
  });

  it('retire a stage as of the moment the body names, and answer false the second time', async () => {
    await call('PUT', stagePath, { body: stageRecord() });

    const first = await call('DELETE', stagePath, { body: GONE });
    const second = await call('DELETE', `/api/internal/stages/${STAGE_ID.toUpperCase()}`, { body: GONE });

    assert.deepEqual(first.body, { retired: true });
    assert.deepEqual(second.body, { retired: false });
    assert.equal(stages.rows.get(STAGE_ID)?.retired_observed_at?.toISOString(), GONE.observedAt, 'the row stays');
  });

  it('answer false for a stage never stored, and keep the retirement', async () => {
    const unknown = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

    const answer = await call('DELETE', `/api/internal/stages/${unknown}`, { body: GONE });

    assert.deepEqual(answer.body, { retired: false });
    assert.equal(stages.tombstones.get(unknown)?.toISOString(), GONE.observedAt);
  });

  it('refuse a retirement or a clear without its moment', async () => {
    await call('PUT', stagePath, { body: stageRecord() });
    await call('PUT', '/api/internal/catalogue-stamp', { body: catalogueStampRecord() });

    for (const path of [stagePath, '/api/internal/catalogue-stamp']) {
      for (const body of [undefined, {}, { observedAt: 'now' }]) {
        const answer = await call('DELETE', path, { body });
        assert.equal(answer.status, 400, `${path} ${JSON.stringify(body)}`);
        assert.equal((answer.body as { error: string }).error, 'validation_error');
      }
    }
    assert.equal(stages.rows.get(STAGE_ID)?.retired_observed_at, null);
    assert.equal(catalogue.row?.cleared_observed_at, null);
  });

  it('store and clear the catalogue stamp', async () => {
    const stored = await call('PUT', '/api/internal/catalogue-stamp', { body: catalogueStampRecord() });
    const refused = await call('PUT', '/api/internal/catalogue-stamp', {
      body: { ...catalogueStampRecord(), beeApiUrl: 'http://user:secret@192.0.2.10:1633' },
    });
    const cleared = await call('DELETE', '/api/internal/catalogue-stamp', { body: GONE });
    const again = await call('DELETE', '/api/internal/catalogue-stamp', { body: GONE });

    assert.deepEqual(stored.body, { stored: true });
    assert.equal(refused.status, 400);
    assert.equal(refused.text.includes('secret'), false);
    assert.deepEqual(cleared.body, { cleared: true });
    assert.deepEqual(again.body, { cleared: false });
  });
});

describe('the console’s stage reads', () => {
  it('answer 401 without a session, and never on the registrar token', async () => {
    for (const path of ['/api/stages', '/api/catalogue-stamp']) {
      assert.equal((await call('GET', path, { token: null })).status, 401, path);
      assert.equal((await call('GET', path)).status, 401, `${path} on the registrar token`);
    }
  });

  it('list every stage without the passphrase or the token hash', async () => {
    await call('PUT', stagePath, { body: stageRecord() });
    const omeId = '6a1d3b9f-2c3d-4e5f-8a51-1b2c3d4e5f60';
    await call('PUT', `/api/internal/stages/${omeId}`, {
      body: stageRecord({
        stageId: omeId,
        name: 'Backup stage',
        engine: 'ome',
        ingest: { ...stageRecord().ingest, srtPassphrase: '' },
        adminToken: null,
      }),
    });

    const answer = await call('GET', '/api/stages', { token: null, cookie });

    assert.equal(answer.status, 200);
    assertNoSecret(answer);
    const { stages: listed } = answer.body as StageListResponse;
    assert.deepEqual(
      listed.map((stage) => [stage.name, stage.engine, stage.supported, stage.ingest.hasSrtPassphrase]),
      [
        ['Backup stage', 'ome', false, false],
        ['Main stage', 'srs', true, true],
      ],
    );
    const main = listed[1]!;
    assert.deepEqual(main.ingest, {
      host: 'ingest.example.org',
      srtPort: 10061,
      rtmpPort: 10062,
      rtmpPublic: false,
      hasSrtPassphrase: true,
    });
    assert.deepEqual(main.rungs[0]?.chequebook, { health: 'ok', availableBzz: '12.5' });
    assert.equal(main.observedAt, '2026-09-28T10:00:00.000Z');
    assert.equal(main.retiredAt, null);
    assert.equal('adminToken' in main, false);
    assert.deepEqual(
      listed.map((stage) => stage.adminTokenKind),
      [null, 'shared'],
      'which token the uploader presents, and never its hash',
    );
  });

  it('answer null for the catalogue stamp until it is set, and never the Bee API address', async () => {
    const before = await call('GET', '/api/catalogue-stamp', { token: null, cookie });
    assert.deepEqual(before.body, {
      catalogueStamp: null,
      catalogueWrite: {
        batch: null,
        refusal: {
          problem: 'none',
          message:
            'The manager has not designated a catalogue batch yet. Nothing is written to the catalogue until it does.',
        },
        moveWaitingTo: null,
      },
    });

    await call('PUT', '/api/internal/catalogue-stamp', { body: catalogueStampRecord() });
    const after = await call('GET', '/api/catalogue-stamp', { token: null, cookie });

    const { catalogueStamp, catalogueWrite } = after.body as CatalogueStampResponse;
    assert.equal(catalogueStamp?.batchId, catalogueStampRecord().batchId);
    assert.equal(catalogueStamp?.depth, 22);
    assert.deepEqual(catalogueWrite, {
      batch: {
        batchId: catalogueStampRecord().batchId,
        nodeName: 'catalogue-node',
        state: 'active',
        ttlSeconds: 30 * 86_400,
        fillRatio: 0.01,
        observedAt: catalogueStampRecord().observedAt,
      },
      refusal: null,
      moveWaitingTo: null,
    });
    assert.equal(after.text.includes('192.0.2.10'), false, 'the Bee API address reached the console');
  });
});
