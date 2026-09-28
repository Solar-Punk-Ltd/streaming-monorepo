/**
 * A pool string may not stamp a stream's segments into the brand's catalogue batch: a create or an update of a
 * deployment whose BEE_PUBLISHERS names the catalogue's batch, or the catalogue node's Bee API, is refused with the
 * catalogue's own sentence, through `POST /profiles` and `PUT /profiles/:name`, designated or cleared since. While a
 * move is pending the batch and the node the catalogue is moving from are refused as well, until they are released.
 *
 * Unit test over the profile service harness, the real catalogue service and an in-memory designation. `pnpm test`
 * in manager/.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { CATALOGUE_SEGMENT_BATCH_REFUSAL } from '@streaming-infra-manager/common';

import { createProfilesRouter } from '../../src/api/routes/profiles.js';
import { beeApiUrlFor } from '../../src/domain/StampService.js';
import { CatalogueDesignationService } from '../../src/domain/stages/CatalogueDesignationService.js';
import { InMemoryCatalogueDesignation } from '../support/InMemoryCatalogueDesignation.js';
import { call, type RouterTestApp, startRouterTestApp } from '../support/routerTestApp.js';
import { uploaderHealthStub } from '../support/uploaderHealthStub.js';

process.env.DATABASE_URL = 'postgres://unused';
const { profileRow, profileServiceHarness } = await import('../support/profileServiceHarness.js');

const CATALOGUE_BATCH = 'ab'.repeat(32);
const NODE_HOST = '192.0.2.40';
const RUNGS = ['360p', '480p', '720p', '1080p'];
const batchOf = (rung: string) => rung.replace(/\D/g, '').padEnd(64, '0');

/** A ladder of four rungs on a pool host, one of them swapped for `entry` when given. */
function poolString(entry?: string): string {
  const entries = RUNGS.map((rung, i) => `${rung}@http://192.0.2.20:${10015 + i * 10}<${batchOf(rung)}>`);
  if (entry) entries[0] = entry;
  return entries.join(' ');
}

describe('a pool string naming the catalogue batch or node', () => {
  const catalogueNode = profileRow({
    name: 'catalogue',
    kind: 'custom',
    components: ['bee-uploader'],
    host: NODE_HOST,
    port_slot: 3,
  });
  const stage = profileRow({ name: 'abr-stage', kind: 'abr-uploader', bee_publishers: poolString() });
  const harness = profileServiceHarness([catalogueNode, stage]);
  const store = new InMemoryCatalogueDesignation();
  const catalogue = new CatalogueDesignationService({
    store,
    profiles: {
      findByName: async (name) => harness.profiles.rows.get(name) ?? null,
      list: async () => [...harness.profiles.rows.values()],
    },
    groupKindOf: async () => null,
    heldBatch: async () => {
      throw new Error('not asked');
    },
    status: () => ({ reading: null, previousReading: null, lastPush: null }),
    changed: () => undefined,
    nodeUrls: async (profile) => [beeApiUrlFor(profile)],
  });
  harness.service.setPoolStringGuard((beePublishers) => catalogue.segmentBatchProblem(beePublishers));
  const nodeUrl = beeApiUrlFor(catalogueNode);
  let app: RouterTestApp;

  before(async () => {
    await store.designate(
      { profileName: 'catalogue', batchId: CATALOGUE_BATCH, batchDepth: 20, at: new Date(0) },
      0,
      'operator',
    );
    app = await startRouterTestApp(createProfilesRouter(harness.service, uploaderHealthStub(), false), '/profiles');
  });
  after(() => app.close());

  const refusal = (answer: { status: number; body: unknown }) => {
    assert.equal(answer.status, 400, JSON.stringify(answer.body));
    return (answer.body as { errors: string[] }).errors;
  };

  it('refuses a create whose pool string names the catalogue batch', async () => {
    const answer = await call(app, 'POST', '/profiles', {
      name: 'abr-two',
      kind: 'abr-uploader',
      private_key: `0x${'1'.repeat(64)}`,
      bee_publishers: poolString(`360p@http://192.0.2.20:10015<${CATALOGUE_BATCH}>`),
    });
    assert.deepEqual(refusal(answer), [CATALOGUE_SEGMENT_BATCH_REFUSAL]);
    assert.equal(harness.profiles.rows.has('abr-two'), false);
  });

  it('refuses an update whose pool string names the catalogue node’s Bee API, with another batch', async () => {
    const answer = await call(app, 'PUT', '/profiles/abr-stage', {
      bee_publishers: poolString(`360p@${nodeUrl}<${'cd'.repeat(32)}>`),
    });
    assert.deepEqual(refusal(answer), [CATALOGUE_SEGMENT_BATCH_REFUSAL]);
    assert.equal(harness.profiles.rows.get('abr-stage')!.bee_publishers, poolString());
  });

  it('still refuses once the designation is cleared, since the catalogue stays pinned to that batch', async () => {
    await store.clear(new Date(1), store.row.revision, 'operator');
    const answer = await call(app, 'PUT', '/profiles/abr-stage', {
      bee_publishers: poolString(`360p@http://192.0.2.20:10015<${CATALOGUE_BATCH}>`),
    });
    assert.deepEqual(refusal(answer), [CATALOGUE_SEGMENT_BATCH_REFUSAL]);
  });

  it('lets through a pool string that names neither', async () => {
    const answer = await call(app, 'PUT', '/profiles/abr-stage', {
      bee_publishers: poolString(`360p@http://192.0.2.21:10015<${'ee'.repeat(32)}>`),
    });
    assert.notEqual(answer.status, 400, JSON.stringify(answer.body));
  });
});

describe('a pool string naming the batch or node the catalogue is moving from', () => {
  const MOVED_TO_BATCH = 'cd'.repeat(32);
  const catalogueNode = profileRow({
    name: 'catalogue',
    kind: 'custom',
    components: ['bee-uploader'],
    host: NODE_HOST,
    port_slot: 3,
  });
  const nextNode = profileRow({
    name: 'catalogue-two',
    kind: 'custom',
    components: ['bee-uploader'],
    host: '192.0.2.41',
    port_slot: 4,
  });
  const stage = profileRow({ name: 'abr-stage', kind: 'abr-uploader', bee_publishers: poolString() });
  const harness = profileServiceHarness([catalogueNode, nextNode, stage]);
  const store = new InMemoryCatalogueDesignation();
  const catalogue = new CatalogueDesignationService({
    store,
    profiles: {
      findByName: async (name) => harness.profiles.rows.get(name) ?? null,
      list: async () => [...harness.profiles.rows.values()],
    },
    groupKindOf: async () => null,
    heldBatch: async () => {
      throw new Error('not asked');
    },
    status: () => ({ reading: null, previousReading: null, lastPush: null }),
    changed: () => undefined,
    nodeUrls: async (profile) => [beeApiUrlFor(profile)],
  });
  harness.service.setPoolStringGuard((beePublishers) => catalogue.segmentBatchProblem(beePublishers));
  const previousUrl = beeApiUrlFor(catalogueNode);
  let app: RouterTestApp;

  before(async () => {
    await store.designate(
      { profileName: 'catalogue', batchId: CATALOGUE_BATCH, batchDepth: 20, at: new Date(0) },
      0,
      'operator',
    );
    await store.move(
      { profileName: 'catalogue-two', batchId: MOVED_TO_BATCH, batchDepth: 21, at: new Date(1) },
      1,
      'operator',
    );
    app = await startRouterTestApp(createProfilesRouter(harness.service, uploaderHealthStub(), false), '/profiles');
  });
  after(() => app.close());

  const refusal = (answer: { status: number; body: unknown }) => {
    assert.equal(answer.status, 400, JSON.stringify(answer.body));
    return (answer.body as { errors: string[] }).errors;
  };

  it('refuses the batch moved from, and the one moved to, while the move is pending', async () => {
    for (const batch of [CATALOGUE_BATCH, MOVED_TO_BATCH]) {
      const answer = await call(app, 'PUT', '/profiles/abr-stage', {
        bee_publishers: poolString(`360p@http://192.0.2.20:10015<${batch}>`),
      });
      assert.deepEqual(refusal(answer), [CATALOGUE_SEGMENT_BATCH_REFUSAL], batch);
    }
  });

  it('refuses the Bee API of the node moved from, with another batch', async () => {
    const answer = await call(app, 'PUT', '/profiles/abr-stage', {
      bee_publishers: poolString(`360p@${previousUrl}<${'ee'.repeat(32)}>`),
    });
    assert.deepEqual(refusal(answer), [CATALOGUE_SEGMENT_BATCH_REFUSAL]);
  });

  it('lets the batch and the node moved from through once the batch is released', async () => {
    await store.release(new Date(2), store.row.revision, 'operator');
    const batch = await call(app, 'PUT', '/profiles/abr-stage', {
      bee_publishers: poolString(`360p@http://192.0.2.20:10015<${CATALOGUE_BATCH}>`),
    });
    assert.notEqual(batch.status, 400, JSON.stringify(batch.body));
    const node = await call(app, 'PUT', '/profiles/abr-stage', {
      bee_publishers: poolString(`360p@${previousUrl}<${'ee'.repeat(32)}>`),
    });
    assert.notEqual(node.status, 400, JSON.stringify(node.body));
  });
});
