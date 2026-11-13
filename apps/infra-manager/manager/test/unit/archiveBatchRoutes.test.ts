/**
 * The brand's archive batches on the Manager settings page, through `GET`, `PUT` and
 * `DELETE /manager-settings/archive-batches[/:batchId]`, and the two ports the funding API calls.
 *
 * Unit test, no database, no Docker and no Bee node, over the real service and router, in-memory stores, a fake node
 * and the real session and same-site gates. `pnpm test` in manager/.
 *
 * Only an immutable batch the catalogue node holds, with life left, that is neither the catalogue's own nor an
 * archive batch already, is adopted, and every refusal says why in a sentence. Only an expired batch is removed. A
 * purchase designated twice makes one row, and an adopt goes through the same designation. The catalogue is never
 * designated onto an archive batch.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it, type TestContext } from 'node:test';

import express from 'express';

import {
  ARCHIVE_ALREADY_REFUSAL,
  ARCHIVE_EXPIRED_REFUSAL,
  ARCHIVE_KIND_UNKNOWN_REFUSAL,
  ARCHIVE_MUTABLE_REFUSAL,
  ARCHIVE_NO_CATALOGUE_NODE_REFUSAL,
  ARCHIVE_NOT_HELD_REFUSAL,
  ARCHIVE_REMOVE_LIVE_REFUSAL,
  ARCHIVE_REMOVE_UNREAD_REFUSAL,
  ARCHIVE_UNKNOWN_REFUSAL,
  ARCHIVE_UNREACHABLE_REFUSAL,
  type ArchiveBatchDesignation,
  archiveIsCatalogueBatchRefusal,
  catalogueIsArchiveBatchRefusal,
  type CatalogueReading,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  SESSION_COOKIE_NAME,
} from '@streaming-infra-manager/common';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createRequireSession } from '../../src/api/middleware/requireSession.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { createArchiveBatchesRouter } from '../../src/api/routes/archiveBatches.js';
import type { AuthService } from '../../src/domain/auth/AuthService.js';
import type { BeeStamp } from '../../src/domain/BeeClient.js';
import { ProfileNotFoundError, StampNotFoundError } from '../../src/domain/errors/index.js';
import { ArchiveBatchService, archiveBatchWritable } from '../../src/domain/stages/ArchiveBatchService.js';
import { CatalogueDesignationService } from '../../src/domain/stages/CatalogueDesignationService.js';
import { InMemoryArchiveBatches } from '../support/InMemoryArchiveBatches.js';
import { InMemoryCatalogueDesignation } from '../support/InMemoryCatalogueDesignation.js';
import { makeProfile } from '../support/profileFixtures.js';

const CATALOGUE_BATCH = 'c1'.repeat(32);
const MOVED_FROM_BATCH = 'c2'.repeat(32);
const BATCH = 'ab'.repeat(32);
const OTHER_BATCH = 'cd'.repeat(32);
const OLD_NODE_BATCH = 'ef'.repeat(32);
const REQUEST_ID = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const NOW = Date.parse('2026-11-13T09:00:00.000Z');

const session = {
  async sessionFor(token: string) {
    return token === 'test-session'
      ? {
          user: { id: 7, username: 'operator', isAdmin: false },
          tokenHash: 'test-hash',
          expiresAt: new Date(Date.now() + 60_000),
        }
      : null;
  },
} as unknown as AuthService;

function stampOf(over: Partial<BeeStamp> = {}): BeeStamp {
  return {
    batchID: BATCH,
    utilization: 3,
    usable: true,
    depth: 22,
    amount: '48000000',
    bucketDepth: 16,
    blockNumber: 39_000_000,
    immutableFlag: true,
    exists: true,
    batchTTL: 30 * 86_400,
    ...over,
  };
}

function readingOf(batchId: string, over: Partial<CatalogueReading> = {}): CatalogueReading {
  return {
    batchId,
    state: 'active',
    ttlSeconds: 30 * 86_400,
    fillRatio: 0.1,
    immutable: true,
    depth: 22,
    readAt: new Date(NOW).toISOString(),
    ...over,
  };
}

function archiveRow(batchId: string, over: Partial<ArchiveBatchDesignation> = {}): ArchiveBatchDesignation {
  return {
    batchId,
    profileName: 'catalogue',
    label: null,
    source: 'adopted',
    purchaseRequestId: null,
    designatedAt: new Date(NOW - 60_000).toISOString(),
    designatedBy: 'operator',
    ...over,
  };
}

interface Setup {
  /** Whether the catalogue node is designated, on `catalogue` with CATALOGUE_BATCH. On by default. */
  designated?: boolean;
  /** Whether the designation was taken out since. */
  cleared?: boolean;
  /** A pending move off MOVED_FROM_BATCH. */
  moving?: boolean;
  rows?: ArchiveBatchDesignation[];
  /** What the catalogue node lists. */
  stamps?: () => Promise<BeeStamp[]>;
  /** What a node answers for one batch, or throws. */
  held?: (name: string, batchId: string) => Promise<BeeStamp>;
  readings?: CatalogueReading[];
}

async function testApi(t: TestContext, setup: Setup = {}) {
  const designation = new InMemoryCatalogueDesignation();
  if (setup.designated !== false) {
    designation.row = {
      ...designation.row,
      profileName: 'catalogue',
      batchId: CATALOGUE_BATCH,
      batchDepth: 20,
      designatedAt: new Date(NOW - 3_600_000),
      designatedBy: 'operator',
      clearedAt: setup.cleared ? new Date(NOW - 60_000) : null,
      revision: 1,
      ...(setup.moving
        ? {
            movingFromProfileName: 'catalogue-old',
            movingFromBatchId: MOVED_FROM_BATCH,
            movingFromBatchDepth: 20,
            moveStartedAt: new Date(NOW - 1_800_000),
            moveStartedBy: 'operator',
          }
        : {}),
    };
  }
  const store = new InMemoryArchiveBatches();
  store.rows = [...(setup.rows ?? [])];
  const asked: string[] = [];
  let changes = 0;
  const service = new ArchiveBatchService({
    store,
    designation,
    listStamps: async () =>
      setup.stamps
        ? setup.stamps()
        : [
            stampOf({ batchID: CATALOGUE_BATCH }),
            stampOf({ batchID: BATCH, label: 'spare' }),
            stampOf({ batchID: OTHER_BATCH, immutableFlag: false }),
          ],
    heldBatch: async (name, batchId) => {
      asked.push(`${name}:${batchId}`);
      return setup.held ? setup.held(name, batchId) : stampOf({ batchID: batchId });
    },
    status: () => ({
      readings: new Map((setup.readings ?? []).map((reading) => [reading.batchId, reading])),
      lastPush: { kind: 'store', outcome: 'stored', at: new Date(NOW).toISOString() },
    }),
    changed: () => void (changes += 1),
    now: () => NOW,
  });

  const app = express();
  app.use(requireSameSite);
  app.use(express.json());
  app.use(createRequireSession(session));
  app.use('/', createArchiveBatchesRouter(service));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  async function send(method: string, path: string, body?: unknown, { authenticated = true, sameSite = true } = {}) {
    const response = await fetch(`${base}/manager-settings/archive-batches${path}`, {
      method,
      headers: {
        ...(authenticated ? { cookie: `${SESSION_COOKIE_NAME}=test-session` } : {}),
        ...(sameSite ? { [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
      cache: response.headers.get('cache-control'),
    };
  }

  return {
    store,
    asked,
    changes: () => changes,
    service,
    read: (options?: { authenticated?: boolean }) => send('GET', '', undefined, options),
    adopt: (batchId: string, body: unknown, options?: { authenticated?: boolean; sameSite?: boolean }) =>
      send('PUT', `/${batchId}`, body, options),
    remove: (batchId: string, body: unknown, options?: { authenticated?: boolean; sameSite?: boolean }) =>
      send('DELETE', `/${batchId}`, body, options),
  };
}

function refusalOf(answer: { status: number; body?: Record<string, unknown> }): string {
  assert.equal(answer.status, 422, JSON.stringify(answer.body));
  assert.equal(answer.body?.error, 'archive_batch_refused');
  return answer.body?.message as string;
}

describe('GET /manager-settings/archive-batches', () => {
  it('answers an empty list with no catalogue node designated, and is not cached', async (t) => {
    const api = await testApi(t, { designated: false });
    const answer = await api.read();
    assert.equal(answer.status, 200);
    assert.equal(answer.cache, 'no-store');
    assert.deepEqual(answer.body, {
      catalogueProfileName: null,
      batches: [],
      candidates: [],
      candidatesError: null,
      revision: 0,
      lastPush: { kind: 'store', outcome: 'stored', at: new Date(NOW).toISOString() },
    });
  });

  it('lists each archive batch with its last reading and whether it is writable', async (t) => {
    const api = await testApi(t, {
      rows: [
        archiveRow(OTHER_BATCH, { label: 'first' }),
        archiveRow(OLD_NODE_BATCH, {
          profileName: 'catalogue-old',
          designatedAt: new Date(NOW - 30_000).toISOString(),
        }),
      ],
      readings: [readingOf(OTHER_BATCH), readingOf(OLD_NODE_BATCH)],
    });
    const body = (await api.read()).body!;
    const batches = body.batches as Array<Record<string, unknown>>;
    assert.deepEqual(
      batches.map((batch) => [batch.batchId, batch.profileName, batch.writable]),
      [
        [OTHER_BATCH, 'catalogue', true],
        // A batch left on a node that is the catalogue node no longer is listed, and nothing is copied onto it.
        [OLD_NODE_BATCH, 'catalogue-old', false],
      ],
    );
    assert.deepEqual(batches[0]!.reading, readingOf(OTHER_BATCH));
    assert.equal(body.catalogueProfileName, 'catalogue');
  });

  it('keeps listing the archive batches, none writable, once the designation is cleared', async (t) => {
    const api = await testApi(t, { cleared: true, rows: [archiveRow(BATCH)], readings: [readingOf(BATCH)] });
    const body = (await api.read()).body!;
    assert.equal(body.catalogueProfileName, null);
    assert.deepEqual(
      (body.batches as Array<Record<string, unknown>>).map((batch) => [batch.batchId, batch.writable]),
      [[BATCH, false]],
    );
    assert.deepEqual(body.candidates, []);
  });

  it('lists the other batches the catalogue node holds, each with why it cannot be adopted', async (t) => {
    const api = await testApi(t, { rows: [archiveRow(OTHER_BATCH)] });
    const candidates = (await api.read()).body!.candidates as Array<Record<string, unknown>>;
    // The archive batch is no candidate. The catalogue's own batch is, with the sentence that refuses it.
    assert.deepEqual(
      candidates.map((candidate) => [candidate.batchId, candidate.nodeLabel, candidate.problem]),
      [
        [CATALOGUE_BATCH, null, archiveIsCatalogueBatchRefusal(CATALOGUE_BATCH)],
        [BATCH, 'spare', null],
      ],
    );
    assert.deepEqual(
      { depth: candidates[1]!.depth, immutable: candidates[1]!.immutable, ttlSeconds: candidates[1]!.ttlSeconds },
      { depth: 22, immutable: true, ttlSeconds: 30 * 86_400 },
    );
  });

  it('says why the candidates could not be read when the node does not answer', async (t) => {
    const api = await testApi(t, { stamps: () => Promise.reject(new Error('connect ECONNREFUSED')) });
    const body = (await api.read()).body!;
    assert.deepEqual(body.candidates, []);
    assert.equal(body.candidatesError, ARCHIVE_UNREACHABLE_REFUSAL);
  });

  it('refuses a caller without a session', async (t) => {
    const api = await testApi(t);
    assert.equal((await api.read({ authenticated: false })).status, 401);
  });
});

describe('PUT /manager-settings/archive-batches/:batchId', () => {
  it('adopts an immutable batch the catalogue node holds, with its trimmed label, and pushes', async (t) => {
    const api = await testApi(t);
    const answer = await api.adopt(`0x${BATCH.toUpperCase()}`, { expectedRevision: 0, label: '  Spring archive ' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.cache, 'no-store');
    assert.deepEqual(api.store.rows, [
      {
        batchId: BATCH,
        profileName: 'catalogue',
        label: 'Spring archive',
        source: 'adopted',
        purchaseRequestId: null,
        designatedAt: new Date(NOW).toISOString(),
        designatedBy: 'operator',
      },
    ]);
    assert.equal(answer.body?.revision, 1);
    assert.deepEqual(api.asked, [`catalogue:${BATCH}`]);
    assert.equal(api.changes(), 1);
  });

  it('adopts with no label', async (t) => {
    const api = await testApi(t);
    assert.equal((await api.adopt(BATCH, { expectedRevision: 0, label: null })).status, 200);
    assert.equal(api.store.rows[0]?.label, null);
  });

  it('refuses every batch that cannot be an archive batch, with the sentence why', async (t) => {
    const cases: Array<[string, Partial<BeeStamp> | Error, string]> = [
      ['mutable', { immutableFlag: false }, ARCHIVE_MUTABLE_REFUSAL],
      ['of no reported kind', { immutableFlag: undefined as unknown as boolean }, ARCHIVE_KIND_UNKNOWN_REFUSAL],
      ['expired', { batchTTL: 0 }, ARCHIVE_EXPIRED_REFUSAL],
      ['disowned', { exists: false }, ARCHIVE_NOT_HELD_REFUSAL],
      ['not held', new StampNotFoundError('catalogue', BATCH), ARCHIVE_NOT_HELD_REFUSAL],
      ['on a node that does not answer', new Error('connect ECONNREFUSED'), ARCHIVE_UNREACHABLE_REFUSAL],
    ];
    for (const [name, answer, sentence] of cases) {
      const api = await testApi(t, {
        held: async (_node, batchId) => {
          if (answer instanceof Error) throw answer;
          return stampOf({ batchID: batchId, ...answer });
        },
      });
      assert.equal(refusalOf(await api.adopt(BATCH, { expectedRevision: 0, label: null })), sentence, name);
      assert.deepEqual(api.store.rows, [], name);
      assert.equal(api.changes(), 0, name);
    }
  });

  it("refuses the catalogue's pinned batch, the one a move left and an archive batch, before the node is asked", async (t) => {
    const api = await testApi(t, { moving: true, rows: [archiveRow(OTHER_BATCH)] });
    assert.equal(
      refusalOf(await api.adopt(CATALOGUE_BATCH, { expectedRevision: 0, label: null })),
      archiveIsCatalogueBatchRefusal(CATALOGUE_BATCH),
    );
    assert.equal(
      refusalOf(await api.adopt(MOVED_FROM_BATCH, { expectedRevision: 0, label: null })),
      archiveIsCatalogueBatchRefusal(MOVED_FROM_BATCH),
    );
    assert.equal(
      refusalOf(await api.adopt(OTHER_BATCH, { expectedRevision: 0, label: null })),
      ARCHIVE_ALREADY_REFUSAL,
    );
    assert.deepEqual(api.asked, []);
  });

  it('refuses with no catalogue node designated, never or since a clear', async (t) => {
    for (const setup of [{ designated: false }, { cleared: true }]) {
      const api = await testApi(t, setup);
      assert.equal(
        refusalOf(await api.adopt(BATCH, { expectedRevision: 0, label: null })),
        ARCHIVE_NO_CATALOGUE_NODE_REFUSAL,
        JSON.stringify(setup),
      );
      assert.deepEqual(api.asked, []);
    }
  });

  it('refuses a save made against a revision another one moved past', async (t) => {
    const api = await testApi(t, { rows: [archiveRow(OTHER_BATCH)] });
    api.store.currentRevision = 3;
    const answer = await api.adopt(BATCH, { expectedRevision: 2, label: null });
    assert.equal(answer.status, 409);
    assert.equal(answer.body?.error, 'manager_settings_changed');
    assert.equal(api.store.rows.length, 1);
  });

  it('refuses a malformed batch id, label or body as a validation error', async (t) => {
    const api = await testApi(t);
    const bodies: Array<[string, unknown]> = [
      ['nope', { expectedRevision: 0, label: null }],
      [BATCH, { expectedRevision: 0, label: '   ' }],
      [BATCH, { expectedRevision: 0, label: 'x'.repeat(65) }],
      [BATCH, { expectedRevision: 0 }],
      [BATCH, { expectedRevision: 0, label: 7 }],
      [BATCH, { expectedRevision: -1, label: null }],
      [BATCH, { expectedRevision: 0, label: null, source: 'purchase' }],
    ];
    for (const [batchId, body] of bodies) {
      const answer = await api.adopt(batchId, body);
      assert.equal(answer.status, 400, `${batchId} ${JSON.stringify(body)}`);
      assert.equal(answer.body?.error, 'validation_error');
    }
    assert.deepEqual(api.store.rows, []);
  });

  it('refuses a request without a session or from another site', async (t) => {
    const api = await testApi(t);
    assert.equal((await api.adopt(BATCH, { expectedRevision: 0, label: null }, { authenticated: false })).status, 401);
    assert.equal((await api.adopt(BATCH, { expectedRevision: 0, label: null }, { sameSite: false })).status, 403);
    assert.deepEqual(api.store.rows, []);
  });
});

describe('DELETE /manager-settings/archive-batches/:batchId', () => {
  it('takes an expired batch off the list, and pushes', async (t) => {
    const api = await testApi(t, {
      rows: [archiveRow(BATCH)],
      held: async (_node, batchId) => stampOf({ batchID: batchId, batchTTL: 0 }),
    });
    const answer = await api.remove(BATCH, { expectedRevision: 0 });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body?.batches, []);
    assert.equal(answer.body?.revision, 1);
    assert.equal(api.changes(), 1);
  });

  it('takes off a batch the node dropped, and one whose deployment is gone', async (t) => {
    for (const error of [new StampNotFoundError('catalogue', BATCH), new ProfileNotFoundError('catalogue')]) {
      const api = await testApi(t, {
        rows: [archiveRow(BATCH)],
        held: async () => {
          throw error;
        },
      });
      assert.equal((await api.remove(BATCH, { expectedRevision: 0 })).status, 200, error.name);
      assert.deepEqual(api.store.rows, [], error.name);
    }
  });

  it('keeps a batch with life left, a full one and one not yet usable', async (t) => {
    for (const over of [{}, { utilization: 64 }, { usable: false }]) {
      const api = await testApi(t, {
        rows: [archiveRow(BATCH)],
        held: async (_node, batchId) => stampOf({ batchID: batchId, ...over }),
      });
      assert.equal(refusalOf(await api.remove(BATCH, { expectedRevision: 0 })), ARCHIVE_REMOVE_LIVE_REFUSAL);
      assert.equal(api.store.rows.length, 1);
      assert.equal(api.changes(), 0);
    }
  });

  it('keeps a batch whose node does not answer', async (t) => {
    const api = await testApi(t, {
      rows: [archiveRow(BATCH)],
      held: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    assert.equal(refusalOf(await api.remove(BATCH, { expectedRevision: 0 })), ARCHIVE_REMOVE_UNREAD_REFUSAL);
    assert.equal(api.store.rows.length, 1);
  });

  it('answers 404 for a batch that is no archive batch, and 409 for a revision behind', async (t) => {
    const api = await testApi(t, { rows: [archiveRow(BATCH)] });
    const missing = await api.remove(OTHER_BATCH, { expectedRevision: 0 });
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'archive_batch_not_found', message: ARCHIVE_UNKNOWN_REFUSAL });
    api.store.currentRevision = 2;
    const behind = await api.remove(BATCH, { expectedRevision: 1 });
    assert.equal(behind.status, 409);
    assert.equal(behind.body?.error, 'manager_settings_changed');
    assert.equal(api.store.rows.length, 1);
  });
});

describe('the ports the funding API calls', () => {
  const bought = {
    batchId: BATCH.toUpperCase(),
    profileName: 'catalogue',
    label: 'Bought',
    designatedBy: null,
    purchaseRequestId: REQUEST_ID.toUpperCase(),
  };

  it('designates a bought batch once, however often a purchase is settled, and pushes once', async (t) => {
    const api = await testApi(t);
    await api.service.designateArchiveBatch(bought);
    await api.service.designateArchiveBatch(bought);
    assert.deepEqual(await api.service.list(), [
      {
        batchId: BATCH,
        profileName: 'catalogue',
        label: 'Bought',
        source: 'purchase',
        purchaseRequestId: REQUEST_ID,
        designatedAt: new Date(NOW).toISOString(),
        designatedBy: null,
      },
    ]);
    assert.equal(api.store.currentRevision, 1);
    assert.equal(api.changes(), 1);
  });

  it('designates at whatever revision the list is at', async (t) => {
    const api = await testApi(t);
    api.store.currentRevision = 7;
    await api.service.designateArchiveBatch(bought);
    assert.equal(api.store.currentRevision, 8);
  });

  it('designates a batch with no purchase as adopted, by the one named', async (t) => {
    const api = await testApi(t);
    await api.service.designateArchiveBatch({ ...bought, designatedBy: 'operator', purchaseRequestId: null });
    assert.deepEqual(
      api.store.rows.map((row) => [row.source, row.purchaseRequestId, row.designatedBy]),
      [['adopted', null, 'operator']],
    );
  });

  it('changes nothing for a batch that is an archive batch already', async (t) => {
    const api = await testApi(t, { rows: [archiveRow(BATCH)] });
    await api.service.designateArchiveBatch(bought);
    assert.equal(api.store.rows.length, 1);
    assert.equal(api.store.rows[0]?.source, 'adopted');
    assert.equal(api.store.currentRevision, 0);
    assert.equal(api.changes(), 0);
  });

  it('rejects when the row could not be written, and pushes nothing', async (t) => {
    const api = await testApi(t);
    api.store.designate = () => Promise.reject(new Error('the database went away'));
    await assert.rejects(api.service.designateArchiveBatch(bought), /the database went away/);
    assert.equal(api.changes(), 0);
  });

  it('lists the archive batches in the order they were designated', async (t) => {
    const api = await testApi(t, {
      rows: [
        archiveRow(OTHER_BATCH, { designatedAt: new Date(NOW).toISOString() }),
        archiveRow(BATCH, { designatedAt: new Date(NOW - 1_000).toISOString() }),
      ],
    });
    assert.deepEqual(
      (await api.service.list()).map((row) => row.batchId),
      [BATCH, OTHER_BATCH],
    );
  });
});

describe('the catalogue designation', () => {
  it('refuses an archive batch, and designates another', async (t) => {
    const api = await testApi(t, { designated: false, rows: [archiveRow(BATCH)] });
    const catalogue = new CatalogueDesignationService({
      store: new InMemoryCatalogueDesignation(),
      profiles: {
        findByName: async (name) => makeProfile({ name, kind: 'custom', components: ['bee-uploader'] }),
        list: async () => [],
      },
      groupKindOf: async () => null,
      heldBatch: async (_name, batchId) => stampOf({ batchID: batchId, depth: 20 }),
      status: () => ({ reading: null, previousReading: null, lastPush: null }),
      changed: () => undefined,
      isArchiveBatch: (batchId) => api.service.isArchiveBatch(batchId),
    });
    await assert.rejects(
      catalogue.designate({ expectedRevision: 0, profileName: 'catalogue', batchId: `0x${BATCH}` }, 'operator'),
      (err: Error & { reasons?: string[] }) => {
        assert.deepEqual(err.reasons, [catalogueIsArchiveBatchRefusal(BATCH)]);
        return true;
      },
    );
    const saved = await catalogue.designate(
      { expectedRevision: 0, profileName: 'catalogue', batchId: OTHER_BATCH },
      'operator',
    );
    assert.equal(saved.designation?.batchId, OTHER_BATCH);
  });
});

describe('whether an archive batch is writable', () => {
  it('is true only for a usable batch with life left on the designated catalogue node', () => {
    assert.equal(archiveBatchWritable('catalogue', 'catalogue', 'active'), true);
    assert.equal(archiveBatchWritable('catalogue', 'catalogue', 'full'), true);
    for (const state of ['pending', 'expired', 'gone', 'unknown', 'none'] as const) {
      assert.equal(archiveBatchWritable('catalogue', 'catalogue', state), false, state);
    }
    assert.equal(archiveBatchWritable('catalogue', 'catalogue', null), false);
    assert.equal(archiveBatchWritable('catalogue-old', 'catalogue', 'active'), false);
    assert.equal(archiveBatchWritable('catalogue', null, 'active'), false);
  });
});
