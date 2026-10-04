/**
 * The brand's catalogue node, designated on the Manager settings page through `GET`, `PUT` and
 * `DELETE /manager-settings/catalogue-node`, moved to another batch with `PUT` and `move: true`, and the batch moved
 * from released through `POST /manager-settings/catalogue-node/release`.
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
  CATALOGUE_NO_MOVE_REFUSAL,
  CATALOGUE_NOT_HELD_REFUSAL,
  CATALOGUE_SEGMENT_BATCH_REFUSAL,
  CATALOGUE_UNREACHABLE_REFUSAL,
  catalogueMoveRefusal,
  catalogueReleaseFirstRefusal,
  catalogueShallowBatchRefusal,
  MIN_CATALOGUE_DEPTH,
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
import { Logger } from '../../src/domain/Logger.js';
import { CatalogueDesignationService } from '../../src/domain/stages/CatalogueDesignationService.js';
import type { Profile } from '../../src/types/index.js';
import { InMemoryCatalogueDesignation } from '../support/InMemoryCatalogueDesignation.js';
import { makeProfile } from '../support/profileFixtures.js';

const BATCH = 'ab'.repeat(32);
const OTHER_BATCH = 'cd'.repeat(32);
const POOL_GROUP = 4;
const THIRD_BATCH = 'ef'.repeat(32);
const DESIGNATED_AT = Date.parse('2026-09-28T09:00:00.000Z');
/** What the publisher last read of the batch moved from, which is the first one designated in these tests. */
const PREVIOUS_READING = {
  batchId: BATCH,
  state: 'active' as const,
  ttlSeconds: 50,
  fillRatio: 0.2,
  immutable: true,
  depth: 20,
  readAt: new Date(DESIGNATED_AT).toISOString(),
};

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
  /** The service's clock, the designation's moment unless a test moves it. */
  now?: () => number;
}

async function testApi(t: TestContext, setup: Setup = {}) {
  const store = new InMemoryCatalogueDesignation();
  const profiles = setup.profiles ?? [
    makeProfile({ name: 'catalogue', kind: 'custom', components: ['bee-uploader'] }),
    makeProfile({ name: 'catalogue-two', kind: 'custom', components: ['bee-uploader'] }),
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
      previousReading: PREVIOUS_READING,
      lastPush: { kind: 'store', outcome: 'stored', at: new Date(DESIGNATED_AT).toISOString() },
    }),
    changed: () => void (changes += 1),
    now: setup.now ?? (() => DESIGNATED_AT),
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

  async function send(method: string, body?: unknown, { authenticated = true, sameSite = true } = {}, path = '') {
    const response = await fetch(`${base}/manager-settings/catalogue-node${path}`, {
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
    release: (body: unknown, options: { authenticated?: boolean; sameSite?: boolean } = {}) =>
      send('POST', body, options, '/release'),
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
      pinned: null,
      movingFrom: null,
      lastRelease: null,
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

  it('answers no reading while the last reading is of another batch than the one designated', async (t) => {
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

  it('refuses a new batch shallower than the catalogue’s minimum depth, saying so, and stores nothing', async (t) => {
    assert.equal(MIN_CATALOGUE_DEPTH, 18);
    const api = await testApi(t, { held: async (_n, id) => stampOf({ batchID: id, depth: 17 }) });
    const answer = await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    assert.deepEqual(refusalOf(answer), [catalogueShallowBatchRefusal(17)]);
    assert.match(catalogueShallowBatchRefusal(17), /depth 17/);
    assert.match(catalogueShallowBatchRefusal(17), /depth 18 or more/);
    assert.equal(api.store.row.revision, 0);
    assert.equal(api.changes(), 0);
  });

  it('takes a batch of the minimum depth', async (t) => {
    const api = await testApi(t, { held: async (_n, id) => stampOf({ batchID: id, depth: MIN_CATALOGUE_DEPTH }) });
    const answer = await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(api.store.row.batchDepth, MIN_CATALOGUE_DEPTH);
  });

  it('designates a shallower batch pinned before the minimum again after a clear', async (t) => {
    const api = await testApi(t, { held: async (_n, id) => stampOf({ batchID: id, depth: 17 }) });
    await api.store.designate(
      { profileName: 'catalogue', batchId: BATCH, batchDepth: 17, at: new Date(DESIGNATED_AT) },
      0,
      'operator',
    );
    await api.clear({ expectedRevision: 1 });
    const again = await api.save({ expectedRevision: 2, profileName: 'catalogue', batchId: BATCH });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(api.store.row.clearedAt, null);
  });

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

describe('another batch than the pinned one is a move, saved only when confirmed', () => {
  const MOVE = catalogueMoveRefusal(BATCH, OTHER_BATCH);

  it('says the batch would move the catalogue and has to be confirmed as a move, naming both batches', () => {
    assert.equal(
      MOVE,
      'Batch cdcdcdcd…cdcdcd would move the catalogue off batch abababab…ababab, whose slots the web2 admin then stamps again under the new batch, so it is saved only when confirmed as a move.',
    );
  });

  it('refuses another batch without move: true, before asking the node', async (t) => {
    const api = await testApi(t);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    const answer = await api.save({ expectedRevision: 1, profileName: 'catalogue', batchId: OTHER_BATCH });
    assert.deepEqual(refusalOf(answer), [MOVE]);
    const unconfirmed = await api.save({
      expectedRevision: 1,
      profileName: 'catalogue',
      batchId: OTHER_BATCH,
      move: false,
    });
    assert.deepEqual(refusalOf(unconfirmed), [MOVE]);
    assert.deepEqual(api.asked, [`catalogue:${BATCH}`]);
    assert.equal(api.store.row.batchId, BATCH);
    assert.equal(api.store.row.movingFromBatchId, null);
  });

  it('refuses another batch after a clear as well, without move: true', async (t) => {
    const api = await testApi(t);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    await api.clear({ expectedRevision: 1 });
    const answer = await api.save({ expectedRevision: 2, profileName: 'catalogue', batchId: OTHER_BATCH });
    assert.deepEqual(refusalOf(answer), [MOVE]);
    assert.equal(api.store.row.batchId, BATCH);
    assert.notEqual(api.store.row.clearedAt, null, 'still cleared');
  });

  it('moves the catalogue to a batch on another Bee-only node, keeping the batch it moved from', async (t) => {
    const api = await testApi(t);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    const moved = await api.save({
      expectedRevision: 1,
      profileName: 'catalogue-two',
      batchId: OTHER_BATCH,
      move: true,
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(moved.body?.designation, {
      profileName: 'catalogue-two',
      batchId: OTHER_BATCH,
      designatedAt: new Date(DESIGNATED_AT).toISOString(),
      designatedBy: 'operator',
    });
    assert.deepEqual(moved.body?.pinned, { profileName: 'catalogue-two', batchId: OTHER_BATCH });
    assert.deepEqual(moved.body?.movingFrom, {
      profileName: 'catalogue',
      batchId: BATCH,
      startedAt: new Date(DESIGNATED_AT).toISOString(),
      startedBy: 'operator',
      reading: PREVIOUS_READING,
    });
    assert.equal(moved.body?.revision, 2);
    assert.equal(moved.body?.reading, null, 'the publisher has not read the new batch yet');
    assert.deepEqual(api.asked, [`catalogue:${BATCH}`, `catalogue-two:${OTHER_BATCH}`], 'the new batch is checked');
    assert.equal(api.store.row.movingFromBatchDepth, 20);
    assert.equal(api.changes(), 2, 'the publisher pushes the new batch’s record at once');
    assert.deepEqual(await api.service.guardedNodes(), ['catalogue-two', 'catalogue']);
  });

  it('moves the catalogue after a clear, putting a designation in force again', async (t) => {
    const api = await testApi(t);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    await api.clear({ expectedRevision: 1 });
    const moved = await api.save({ expectedRevision: 2, profileName: 'catalogue', batchId: OTHER_BATCH, move: true });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(api.store.row.clearedAt, null);
    assert.equal((moved.body?.movingFrom as { batchId: string } | undefined)?.batchId, BATCH);
  });

  it('puts the batch moved to through every check a designation passes', async (t) => {
    const api = await testApi(t, {
      held: async (_n, id) => stampOf({ batchID: id, immutableFlag: id === BATCH }),
    });
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    const mutable = await api.save({ expectedRevision: 1, profileName: 'catalogue', batchId: OTHER_BATCH, move: true });
    assert.deepEqual(refusalOf(mutable), [CATALOGUE_MUTABLE_REFUSAL]);
    const stage = await api.save({ expectedRevision: 1, profileName: 'stage-one', batchId: OTHER_BATCH, move: true });
    assert.match(refusalOf(stage)[0]!, /^stage-one runs more than a Bee node\./);
    assert.equal(api.store.row.batchId, BATCH);
    assert.equal(api.store.row.movingFromBatchId, null);
  });

  it('takes move: true for the pinned batch as a designation, and before any designation as the first one', async (t) => {
    const api = await testApi(t);
    const first = await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH, move: true });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body?.movingFrom, null);
    await api.clear({ expectedRevision: 1 });
    const again = await api.save({ expectedRevision: 2, profileName: 'catalogue', batchId: BATCH, move: true });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body?.movingFrom, null);
    assert.equal(api.store.row.moveStartedAt, null);
  });

  it('designates the batch moved to again after a clear, and keeps the move pending', async (t) => {
    const api = await testApi(t);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    await api.save({ expectedRevision: 1, profileName: 'catalogue', batchId: OTHER_BATCH, move: true });
    const cleared = await api.clear({ expectedRevision: 2 });
    assert.equal((cleared.body?.movingFrom as { batchId: string } | undefined)?.batchId, BATCH, 'a clear keeps it');
    const again = await api.save({ expectedRevision: 3, profileName: 'catalogue', batchId: OTHER_BATCH });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal((again.body?.movingFrom as { batchId: string } | undefined)?.batchId, BATCH);
    assert.equal(api.store.row.batchId, OTHER_BATCH);
  });

  it('moves back to the batch moved from, which then holds the move the other way round', async (t) => {
    const api = await testApi(t);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    await api.save({ expectedRevision: 1, profileName: 'catalogue-two', batchId: OTHER_BATCH, move: true });
    const unconfirmed = await api.save({ expectedRevision: 2, profileName: 'catalogue', batchId: BATCH });
    assert.deepEqual(refusalOf(unconfirmed), [catalogueMoveRefusal(OTHER_BATCH, BATCH)]);
    const back = await api.save({ expectedRevision: 2, profileName: 'catalogue', batchId: BATCH, move: true });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.deepEqual(back.body?.pinned, { profileName: 'catalogue', batchId: BATCH });
    assert.equal((back.body?.movingFrom as { profileName: string } | undefined)?.profileName, 'catalogue-two');
    assert.equal((back.body?.movingFrom as { batchId: string } | undefined)?.batchId, OTHER_BATCH);
    assert.equal(
      (back.body?.movingFrom as { reading: unknown } | undefined)?.reading,
      null,
      'the last reading was of another batch',
    );
    assert.deepEqual(await api.service.guardedNodes(), ['catalogue', 'catalogue-two']);
  });

  it('refuses a move to a batch shallower than the minimum, and takes a move back to one pinned before it', async (t) => {
    const api = await testApi(t, {
      held: async (_n, id) => stampOf({ batchID: id, depth: id === OTHER_BATCH ? 20 : 17 }),
    });
    await api.store.designate(
      { profileName: 'catalogue', batchId: BATCH, batchDepth: 17, at: new Date(DESIGNATED_AT) },
      0,
      'operator',
    );
    const shallow = await api.save({ expectedRevision: 1, profileName: 'catalogue', batchId: THIRD_BATCH, move: true });
    assert.deepEqual(refusalOf(shallow), [catalogueShallowBatchRefusal(17)]);
    const moved = await api.save({
      expectedRevision: 1,
      profileName: 'catalogue-two',
      batchId: OTHER_BATCH,
      move: true,
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const back = await api.save({ expectedRevision: 2, profileName: 'catalogue', batchId: BATCH, move: true });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(api.store.row.batchId, BATCH);
    assert.equal(api.store.row.movingFromBatchId, OTHER_BATCH);
  });

  it('refuses a third batch while a move is pending, confirmed or not, naming the batch moved from', async (t) => {
    const api = await testApi(t);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    await api.save({ expectedRevision: 1, profileName: 'catalogue', batchId: OTHER_BATCH, move: true });
    const sentence = catalogueReleaseFirstRefusal(BATCH);
    assert.equal(
      sentence,
      'The catalogue is still moving off batch abababab…ababab, so release the previous batch first, once the web2 admin reports the move done, before moving it to another.',
    );
    const asked = api.asked.length;
    for (const move of [true, false]) {
      const third = await api.save({ expectedRevision: 2, profileName: 'catalogue', batchId: THIRD_BATCH, move });
      assert.deepEqual(refusalOf(third), [sentence]);
    }
    assert.equal(api.asked.length, asked, 'no node is asked');
    assert.equal(api.store.row.batchId, OTHER_BATCH);
    assert.equal(api.store.row.movingFromBatchId, BATCH);
  });

  it('refuses a move at a stale revision, and one that lost the race to the row', async (t) => {
    const api = await testApi(t);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    const stale = await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: OTHER_BATCH, move: true });
    assert.equal(stale.status, 409);
    const move = api.store.move.bind(api.store);
    api.store.move = async (write, revision, username) => {
      api.store.row.revision += 1;
      return move(write, revision, username);
    };
    const raced = await api.save({ expectedRevision: 1, profileName: 'catalogue', batchId: OTHER_BATCH, move: true });
    assert.equal(raced.status, 409);
    assert.equal(api.store.row.movingFromBatchId, null);
    assert.equal(api.changes(), 1);
  });

  it('logs a move and a move back with the user, the batches shortened and the nodes', async (t) => {
    const lines: string[] = [];
    t.mock.method(Logger.prototype, 'info', (...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const api = await testApi(t);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    await api.save({ expectedRevision: 1, profileName: 'catalogue-two', batchId: OTHER_BATCH, move: true });
    await api.save({ expectedRevision: 2, profileName: 'catalogue', batchId: BATCH, move: true });
    assert.deepEqual(lines.slice(1), [
      '[Catalogue] operator moved the catalogue from batch abababab…ababab on catalogue to batch cdcdcdcd…cdcdcd on catalogue-two, now at revision 2',
      '[Catalogue] operator moved the catalogue back from batch cdcdcdcd…cdcdcd on catalogue-two to batch abababab…ababab on catalogue, now at revision 3',
    ]);
  });

  it('refuses a move field that is not a boolean', async (t) => {
    const api = await testApi(t);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    const text = await api.save({ expectedRevision: 1, profileName: 'catalogue', batchId: OTHER_BATCH, move: 'true' });
    assert.deepEqual(refusalOf(text), [
      'move is true to move the catalogue to this batch, false or left out otherwise',
    ]);
    assert.equal(api.store.row.revision, 1);
  });

  it('designates the same batch again after a clear, in force once more', async (t) => {
    const api = await testApi(t);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    await api.clear({ expectedRevision: 1 });
    const again = await api.save({ expectedRevision: 2, profileName: 'catalogue', batchId: `0x${BATCH}` });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal((again.body?.designation as { batchId: string } | undefined)?.batchId, BATCH);
    assert.equal(api.store.row.clearedAt, null);
    assert.equal(api.changes(), 3);
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
  });

  it('keeps the node and the batch recorded after a clear, and the removal guard still names the node', async (t) => {
    const api = await testApi(t);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    const cleared = await api.clear({ expectedRevision: 1 });
    assert.deepEqual(cleared.body?.pinned, { profileName: 'catalogue', batchId: BATCH });
    assert.equal(api.store.row.batchId, BATCH);
    assert.deepEqual(await api.service.guardedNodes(), ['catalogue']);
  });

  it('refuses a clear with nothing designated, and one at a stale revision', async (t) => {
    const api = await testApi(t);
    assert.deepEqual(refusalOf(await api.clear({ expectedRevision: 0 })), ['No catalogue node is designated.']);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    const stale = await api.clear({ expectedRevision: 0 });
    assert.equal(stale.status, 409);
    assert.equal(api.store.row.clearedAt, null);
    assert.equal((await api.clear({ expectedRevision: 1 })).status, 200);
    assert.deepEqual(refusalOf(await api.clear({ expectedRevision: 2 })), ['No catalogue node is designated.']);
  });
});

describe('POST /manager-settings/catalogue-node/release', () => {
  /** A designation of BATCH on catalogue, moved to OTHER_BATCH on catalogue-two, at revision 2. */
  async function moved(t: TestContext) {
    const api = await testApi(t);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    await api.save({ expectedRevision: 1, profileName: 'catalogue-two', batchId: OTHER_BATCH, move: true });
    return api;
  }

  it('releases the batch moved from, records who and when, logs it and tells the publisher', async (t) => {
    const api = await moved(t);
    const lines: string[] = [];
    t.mock.method(Logger.prototype, 'info', (...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const released = await api.release({ expectedRevision: 2 });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.cache, 'no-store');
    assert.equal(released.body?.movingFrom, null);
    assert.deepEqual(released.body?.lastRelease, { at: new Date(DESIGNATED_AT).toISOString(), by: 'operator' });
    assert.deepEqual(released.body?.pinned, { profileName: 'catalogue-two', batchId: OTHER_BATCH });
    assert.equal(released.body?.revision, 3);
    assert.equal(api.store.row.movingFromProfileName, null);
    assert.equal(api.store.row.moveStartedAt, null);
    assert.equal(api.changes(), 3);
    assert.deepEqual(lines, [
      '[Catalogue] operator released batch abababab…ababab on catalogue after the move to cdcdcdcd…cdcdcd',
    ]);
    assert.deepEqual(await api.service.guardedNodes(), ['catalogue-two'], 'the previous node is guarded no more');
  });

  it('lets a third batch be moved to once the previous one is released', async (t) => {
    const api = await moved(t);
    await api.release({ expectedRevision: 2 });
    const third = await api.save({ expectedRevision: 3, profileName: 'catalogue', batchId: THIRD_BATCH, move: true });
    assert.equal(third.status, 200, JSON.stringify(third.body));
    assert.equal((third.body?.movingFrom as { batchId: string } | undefined)?.batchId, OTHER_BATCH);
  });

  it('refuses a release with no move pending, and one at a stale revision', async (t) => {
    const api = await testApi(t);
    assert.deepEqual(refusalOf(await api.release({ expectedRevision: 0 })), [CATALOGUE_NO_MOVE_REFUSAL]);
    await api.save({ expectedRevision: 0, profileName: 'catalogue', batchId: BATCH });
    assert.deepEqual(refusalOf(await api.release({ expectedRevision: 1 })), [CATALOGUE_NO_MOVE_REFUSAL]);
    await api.save({ expectedRevision: 1, profileName: 'catalogue', batchId: OTHER_BATCH, move: true });
    const stale = await api.release({ expectedRevision: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body?.error, 'manager_settings_changed');
    assert.equal(api.store.row.movingFromBatchId, BATCH);
    assert.equal((await api.release({ expectedRevision: 2 })).status, 200);
    assert.deepEqual(refusalOf(await api.release({ expectedRevision: 3 })), [CATALOGUE_NO_MOVE_REFUSAL]);
  });

  it('refuses a release that lost the race to the row between its read and its write', async (t) => {
    const api = await moved(t);
    const release = api.store.release.bind(api.store);
    api.store.release = async (at, revision, username) => {
      api.store.row.revision += 1;
      return release(at, revision, username);
    };
    assert.equal((await api.release({ expectedRevision: 2 })).status, 409);
    assert.equal(api.store.row.movingFromBatchId, BATCH);
    assert.equal(api.changes(), 2);
  });

  it('is behind the session and the same-site check, and refuses an unknown key', async (t) => {
    const api = await moved(t);
    assert.equal((await api.release({ expectedRevision: 2 }, { authenticated: false })).status, 401);
    assert.equal((await api.release({ expectedRevision: 2 }, { sameSite: false })).status, 403);
    assert.equal((await api.release({ expectedRevision: 2, batchId: BATCH })).status, 400);
    assert.equal((await api.release({})).status, 400);
    assert.equal(api.store.row.movingFromBatchId, BATCH);
    assert.equal(api.store.row.revision, 2);
  });
});
