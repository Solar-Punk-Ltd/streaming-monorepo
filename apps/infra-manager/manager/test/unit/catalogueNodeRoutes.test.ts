/**
 * The brand's catalogue node, designated on the Manager settings page through `GET`, `PUT` and
 * `DELETE /manager-settings/catalogue-node`.
 *
 * Unit test, no database, no Docker and no Bee node, over the real service and router, an in-memory store, fake
 * deployments and a fake node, and the real session and same-site gates. `pnpm test` in manager/.
 *
 * Only a deployment that is nothing but a Bee node and no pool's rung, and only a batch its node calls immutable, can
 * hold the catalogue, and every refusal says why in a sentence. A save and a clear name the revision they read.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it, type TestContext } from 'node:test';

import express from 'express';

import {
  ABR_NODE_POOL_GROUP_KIND,
  CATALOGUE_EXPIRED_REFUSAL,
  CATALOGUE_KIND_UNKNOWN_REFUSAL,
  CATALOGUE_MUTABLE_REFUSAL,
  CATALOGUE_NOT_HELD_REFUSAL,
  CATALOGUE_SEGMENT_BATCH_REFUSAL,
  CATALOGUE_UNREACHABLE_REFUSAL,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  SESSION_COOKIE_NAME,
} from '@streaming-infra-manager/common';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createRequireSession } from '../../src/api/middleware/requireSession.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { createCatalogueNodeRouter } from '../../src/api/routes/catalogueNode.js';
import type { AuthService } from '../../src/domain/auth/AuthService.js';
import type { BeeStamp } from '../../src/domain/BeeClient.js';
import { StampNotFoundError } from '../../src/domain/errors/index.js';
import { CatalogueDesignationService } from '../../src/domain/stages/CatalogueDesignationService.js';
import type { Profile } from '../../src/types/index.js';
import { InMemoryCatalogueDesignation } from '../support/InMemoryCatalogueDesignation.js';
import { makeProfile } from '../support/profileFixtures.js';

const BATCH = 'ab'.repeat(32);
const OTHER_BATCH = 'cd'.repeat(32);
const POOL_GROUP = 4;
const DESIGNATED_AT = Date.parse('2026-09-28T09:00:00.000Z');

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
    depth: 20,
    amount: '48000000',
    bucketDepth: 16,
    blockNumber: 39_000_000,
    immutableFlag: true,
    exists: true,
    batchTTL: 90 * 86_400,
    ...over,
  };
}

interface Setup {
  profiles?: Profile[];
  /** What the node answers for a batch, or throws. */
  held?: (name: string, batchId: string) => Promise<BeeStamp>;
}

async function testApi(t: TestContext, setup: Setup = {}) {
  const store = new InMemoryCatalogueDesignation();
  const profiles = setup.profiles ?? [
    makeProfile({ name: 'catalogue', kind: 'custom', components: ['bee-uploader'] }),
    makeProfile({ name: 'stage-one', kind: 'streamer' }),
    makeProfile({ name: 'pool-360p', kind: 'custom', components: ['bee-uploader'], group_id: POOL_GROUP }),
  ];
  const asked: string[] = [];
  let changes = 0;
  const service = new CatalogueDesignationService({
    store,
    profiles: {
      findByName: async (name) => profiles.find((profile) => profile.name === name) ?? null,
      list: async () => profiles,
    },
    groupKindOf: async (id) => (id === POOL_GROUP ? ABR_NODE_POOL_GROUP_KIND : 'standard'),
    heldBatch: async (name, batchId) => {
      asked.push(`${name}:${batchId}`);
      return setup.held ? setup.held(name, batchId) : stampOf({ batchID: batchId });
    },
    status: () => ({
      reading: {
        batchId: BATCH,
        state: 'active',
        ttlSeconds: 100,
        fillRatio: 0.1,
        immutable: true,
        depth: 20,
        readAt: new Date(DESIGNATED_AT).toISOString(),
      },
      lastPush: { kind: 'store', outcome: 'stored', at: new Date(DESIGNATED_AT).toISOString() },
    }),
    changed: () => void (changes += 1),
    now: () => DESIGNATED_AT,
  });

  const app = express();
  app.use(requireSameSite);
  app.use(express.json());
  app.use(createRequireSession(session));
  app.use('/', createCatalogueNodeRouter(service));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  async function send(method: string, body?: unknown, { authenticated = true, sameSite = true } = {}) {
    const response = await fetch(`${base}/manager-settings/catalogue-node`, {
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
    read: (options?: { authenticated?: boolean }) => send('GET', undefined, options),
    save: (body: unknown, options?: { authenticated?: boolean; sameSite?: boolean }) => send('PUT', body, options),
    clear: (body: unknown, options?: { authenticated?: boolean; sameSite?: boolean }) => send('DELETE', body, options),
  };
}

function refusalOf(answer: { status: number; body?: Record<string, unknown> }): string[] {
  assert.equal(answer.status, 400, JSON.stringify(answer.body));
  assert.equal(answer.body?.error, 'validation_error');
  return answer.body?.errors as string[];
}

describe('GET /manager-settings/catalogue-node', () => {
  it('answers no designation before one is made, and is not cached', async (t) => {
    const api = await testApi(t);
    const answer = await api.read();
    assert.equal(answer.status, 200);
    assert.equal(answer.cache, 'no-store');
    assert.deepEqual(answer.body, {
      designation: null,
      revision: 0,
      reading: null,
      lastPush: { kind: 'store', outcome: 'stored', at: new Date(DESIGNATED_AT).toISOString() },
    });
  });

  it('is behind the session', async (t) => {
    const api = await testApi(t);
    assert.equal((await api.read({ authenticated: false })).status, 401);
  });
});

describe('PUT /manager-settings/catalogue-node', () => {
  it('designates a Bee-only deployment and an immutable batch its node holds, and tells the publisher', async (t) => {
    const api = await testApi(t);
    const saved = await api.save({
      expectedRevision: 0,
      profileName: 'catalogue',
      batchId: `0x${BATCH.toUpperCase()}`,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.cache, 'no-store');
    assert.deepEqual(saved.body?.designation, {
      profileName: 'catalogue',
      batchId: BATCH,
      designatedAt: new Date(DESIGNATED_AT).toISOString(),
      designatedBy: 'operator',
    });
    assert.equal(saved.body?.revision, 1);
    assert.equal((saved.body?.reading as { batchId: string } | undefined)?.batchId, BATCH);
    assert.deepEqual(api.asked, [`catalogue:${BATCH}`], 'the node is asked about the batch, fresh');
    assert.equal(api.store.row.batchDepth, 20);
    assert.equal(api.changes(), 1);
    assert.deepEqual((await api.read()).body?.designation, saved.body?.designation);
  });

  it('answers no reading for a batch other than the one designated', async (t) => {
    const api = await testApi(t);
    const saved = await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: OTHER_BATCH });
    assert.equal(saved.status, 200);
    assert.equal(saved.body?.reading, null);
  });

  const batchRefusals: Array<[string, (name: string, batchId: string) => Promise<BeeStamp>, string]> = [
    ['a mutable batch', async (_n, id) => stampOf({ batchID: id, immutableFlag: false }), CATALOGUE_MUTABLE_REFUSAL],
    [
      'a batch whose kind the node did not report',
      async (_n, id) => {
        const stamp: Partial<BeeStamp> = stampOf({ batchID: id });
        delete stamp.immutableFlag;
        return stamp as BeeStamp;
      },
      CATALOGUE_KIND_UNKNOWN_REFUSAL,
    ],
    [
      'an expired batch',
      async (_n, id) => stampOf({ batchID: id, batchTTL: 0, usable: false }),
      CATALOGUE_EXPIRED_REFUSAL,
    ],
    [
      'a batch the node does not hold',
      async (name, id) => {
        throw new StampNotFoundError(name, id);
      },
      CATALOGUE_NOT_HELD_REFUSAL,
    ],
    [
      'a batch on a node that does not answer',
      async () => {
        throw new Error('connect ECONNREFUSED 192.0.2.10:10025');
      },
      CATALOGUE_UNREACHABLE_REFUSAL,
    ],
  ];
  for (const [what, held, sentence] of batchRefusals) {
    it(`refuses ${what}, with the sentence saying why, and stores nothing`, async (t) => {
      const api = await testApi(t, { held });
      const answer = await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
      assert.deepEqual(refusalOf(answer), [sentence]);
      assert.equal(api.store.row.revision, 0);
      assert.equal(api.changes(), 0);
    });
  }

  it('says a mutable batch overwrites the catalogue’s oldest slots', () => {
    assert.match(CATALOGUE_MUTABLE_REFUSAL, /mutable/);
    assert.match(CATALOGUE_MUTABLE_REFUSAL, /overwrites its oldest chunks/);
    assert.match(CATALOGUE_MUTABLE_REFUSAL, /Designate an immutable batch\./);
  });

  it('refuses a deployment that runs more than a Bee node, and a rung of a node pool, before asking any node', async (t) => {
    const api = await testApi(t);
    const stage = refusalOf(await api.save({ expectedRevision: 0, profileName: 'stage-one', batchId: BATCH }));
    assert.match(stage[0]!, /^stage-one runs more than a Bee node\./);
    const rung = refusalOf(await api.save({ expectedRevision: 0, profileName: 'pool-360p', batchId: BATCH }));
    assert.match(rung[0]!, /^pool-360p is a rung of an ABR node pool/);
    const missing = refusalOf(await api.save({ expectedRevision: 0, profileName: 'nowhere', batchId: BATCH }));
    assert.deepEqual(missing, ['There is no deployment called nowhere.']);
    assert.deepEqual(api.asked, []);
  });

  it('refuses a batch an ABR uploader of this manager stamps segments with', async (t) => {
    const api = await testApi(t, {
      profiles: [
        makeProfile({ name: 'catalogue', kind: 'custom', components: ['bee-uploader'] }),
        makeProfile({
          name: 'abr-stage',
          kind: 'abr-uploader',
          bee_publishers: `360p@http://192.0.2.20:10005<${BATCH}>`,
        }),
      ],
    });
    const answer = await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    assert.deepEqual(refusalOf(answer), [CATALOGUE_SEGMENT_BATCH_REFUSAL]);
  });

  it('refuses a save at a revision another save has moved past', async (t) => {
    const api = await testApi(t);
    assert.equal((await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH })).status, 200);
    const stale = await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: OTHER_BATCH });
    assert.equal(stale.status, 409);
    assert.equal(stale.body?.error, 'manager_settings_changed');
    assert.equal(api.store.row.batchId, BATCH);
  });

  it('refuses a save that lost the race to the row between its read and its write', async (t) => {
    const api = await testApi(t);
    const designate = api.store.designate.bind(api.store);
    api.store.designate = async (write, revision, username) => {
      api.store.row.revision += 1;
      return designate(write, revision, username);
    };
    const answer = await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    assert.equal(answer.status, 409);
    assert.equal(api.changes(), 0);
  });

  it('refuses a body with an unknown key, a batch id that is not one, and a cross-site write', async (t) => {
    const api = await testApi(t);
    const extra = await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH, token: 'x' });
    assert.equal(extra.status, 400);
    const badId = await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: 'not-a-batch' });
    assert.equal(badId.status, 400);
    const crossSite = await api.save(
      { expectedRevision: 0, profileName: 'catalogue', batchId: BATCH },
      { sameSite: false },
    );
    assert.equal(crossSite.status, 403);
    assert.equal(api.store.row.revision, 0);
  });
});

describe('DELETE /manager-settings/catalogue-node', () => {
  it('clears the designation as of the manager’s own moment, and tells the publisher', async (t) => {
    const api = await testApi(t);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    const cleared = await api.clear({ expectedRevision: 1 });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body?.designation, null);
    assert.equal(cleared.body?.revision, 2);
    assert.equal(cleared.body?.reading, null);
    assert.deepEqual(api.store.row.clearedAt, new Date(DESIGNATED_AT));
    assert.equal(api.changes(), 2);
    assert.equal(await api.service.designatedNode(), null);
  });

  it('refuses a clear with nothing designated, and one at a stale revision', async (t) => {
    const api = await testApi(t);
    assert.deepEqual(refusalOf(await api.clear({ expectedRevision: 0 })), ['No catalogue node is designated.']);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    const stale = await api.clear({ expectedRevision: 0 });
    assert.equal(stale.status, 409);
    assert.equal(await api.service.designatedNode(), 'catalogue');
  });
});
