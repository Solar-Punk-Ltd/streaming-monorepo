/**
 * The catalogue node is not removed while the catalogue is pinned to it: the web2 admin writes the brand's catalogue
 * through it, so its removal is refused before the deployment is claimed or any script runs. While the catalogue is
 * moving to another batch, the node of the batch it moves from is kept the same way, until that batch is released.
 *
 * Unit test over the orchestrator harness and the real catalogue service with an in-memory designation, no database
 * and no Docker. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, it } from 'node:test';

import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('catalogue-node-removal-');
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
process.env.DATABASE_URL = 'postgres://unused';
after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  writeFileSync(join(root, '.env'), 'ENGINE=srs\n');
  writeFileSync(join(root, '.env.example'), 'ENGINE=srs\n');
  mkdirSync(join(root, 'data'), { recursive: true });
});

const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');
const { InMemoryCatalogueDesignation } = await import('../support/InMemoryCatalogueDesignation.js');
const { CatalogueDesignationService } = await import('../../src/domain/stages/CatalogueDesignationService.js');
const { CatalogueNodeRemovalError } = await import('../../src/domain/errors/index.js');

const BATCH = 'ab'.repeat(32);
const NEXT_BATCH = 'cd'.repeat(32);

function beeOnly(name: string) {
  return makeProfile({
    name,
    kind: 'custom',
    components: ['bee-uploader'],
    instance_id: randomUUID(),
    status: 'RUNNING',
  });
}

function setup() {
  const node = beeOnly('catalogue');
  const next = beeOnly('catalogue-two');
  const h = orchestratorHarness([node, next]);
  const store = new InMemoryCatalogueDesignation();
  const service = new CatalogueDesignationService({
    store,
    profiles: { findByName: async () => null, list: async () => [] },
    groupKindOf: async () => null,
    heldBatch: async () => {
      throw new Error('not asked');
    },
    status: () => ({ reading: null, previousReading: null, lastPush: null }),
    changed: () => undefined,
  });
  h.orchestrator.setRemovalGuard((name) => service.assertRemovable(name));
  return { ...h, node, next, store, service };
}

const designate = (store: InstanceType<typeof InMemoryCatalogueDesignation>) =>
  store.designate({ profileName: 'catalogue', batchId: BATCH, batchDepth: 20, at: new Date(0) }, 0, 'operator');

const moveOn = (store: InstanceType<typeof InMemoryCatalogueDesignation>) =>
  store.move(
    { profileName: 'catalogue-two', batchId: NEXT_BATCH, batchDepth: 20, at: new Date(1) },
    store.row.revision,
    'operator',
  );

it('refuses to remove the designated catalogue node, and claims nothing', async () => {
  const h = setup();
  await designate(h.store);
  await assert.rejects(
    h.orchestrator.startRemove(h.node),
    (err: unknown) =>
      err instanceof CatalogueNodeRemovalError &&
      /Move the catalogue to another node and release this batch on the Manager settings page before removing it\./.test(
        err.message,
      ),
  );
  assert.equal(h.runner.runs.length, 0);
  assert.equal(h.profiles.rows.get('catalogue')!.status, 'RUNNING');
});

it('asks again once the deployment is claimed, and runs nothing when a designation came in between', async () => {
  let asked = 0;
  const h = setup();
  // The first ask passes; by the second, the one before the clean script runs, the node has been designated.
  h.orchestrator.setRemovalGuard(async (name) => {
    if (asked++ === 1) await designate(h.store);
    await h.service.assertRemovable(name);
  });
  await assert.rejects(h.orchestrator.startRemove(h.node), CatalogueNodeRemovalError);
  assert.equal(asked, 2);
  assert.equal(h.runner.runs.length, 0);
});

it('removes a Bee-only deployment that is not the catalogue node', async () => {
  const h = setup();
  await h.orchestrator.startRemove(h.node);
  assert.equal(h.runner.runs.length, 1);
});

it('keeps both nodes while a move is pending, saying which to release for the node moved from', async () => {
  const h = setup();
  await designate(h.store);
  await moveOn(h.store);
  assert.deepEqual(await h.service.guardedNodes(), ['catalogue-two', 'catalogue']);
  await assert.rejects(
    h.orchestrator.startRemove(h.node),
    (err: unknown) =>
      err instanceof CatalogueNodeRemovalError &&
      err.movingFrom &&
      /holds the batch the brand's catalogue is moving from/.test(err.message) &&
      /Release the previous batch on the Manager settings page before removing it\./.test(err.message),
  );
  await assert.rejects(
    h.orchestrator.startRemove(h.next),
    (err: unknown) => err instanceof CatalogueNodeRemovalError && !err.movingFrom,
  );
  assert.equal(h.runner.runs.length, 0);
});

it('lifts the guard on the node moved from once its batch is released, and keeps the pinned one', async () => {
  const h = setup();
  await designate(h.store);
  await moveOn(h.store);
  await h.store.release(new Date(2), h.store.row.revision, 'operator');
  assert.deepEqual(await h.service.guardedNodes(), ['catalogue-two']);
  await assert.rejects(h.orchestrator.startRemove(h.next), CatalogueNodeRemovalError);
  await h.orchestrator.startRemove(h.node);
  assert.equal(h.runner.runs.length, 1);
});

it('keeps a node that holds both batches once, when the catalogue moved on the same node', async () => {
  const h = setup();
  await designate(h.store);
  await h.store.move(
    { profileName: 'catalogue', batchId: NEXT_BATCH, batchDepth: 20, at: new Date(1) },
    h.store.row.revision,
    'operator',
  );
  assert.deepEqual(await h.service.guardedNodes(), ['catalogue']);
  await assert.rejects(h.orchestrator.startRemove(h.node), CatalogueNodeRemovalError);
  await h.orchestrator.startRemove(h.next);
  assert.equal(h.runner.runs.length, 1);
});
