/**
 * An ABR stage deploys with its pool's current postage batches.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * A stage's pool string was copied from its pool once, when the stage was
 * created. Buying a new batch on a rung changes only that rung's `stamp_id`, so
 * the stage went on deploying with the batch the rung had before, and its
 * uploader crash-looped on a batch its node no longer held. A stage whose
 * entries name the nodes of a pool on this manager now takes that pool's
 * current batches at every deploy, and a pool string pasted from anywhere else
 * is left exactly as it is.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ABR_NODE_POOL_GROUP_KIND, beePublishersValue, DEFAULT_ABR_RUNGS } from '@streaming-infra-manager/common';

import type { BeeClient } from '../../src/domain/BeeClient.js';
import { ProfileConfigError } from '../../src/domain/errors/index.js';
import { EventBus } from '../../src/domain/EventBus.js';
import { StampService } from '../../src/domain/StampService.js';
import { StagePoolStrings } from '../../src/domain/stages/StagePoolStrings.js';
import type { DeploymentGroup, Profile } from '../../src/types/index.js';
import { throwawayRoot } from '../support/throwawayRoot.js';
import { FakeContainers, InMemoryProfiles, makeProfile } from '../support/profileFixtures.js';

const root = throwawayRoot('stage-follows-pool-');
process.env.SHLS_ROOT = root;

const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

const PUBLISHER_HOST = '192.0.2.10';
const POOL: DeploymentGroup = { id: 7, name: 'abr', size: 4, kind: ABR_NODE_POOL_GROUP_KIND, created_at: new Date(0) };
const STAGE = 'stage';

const batch = (digit: string) => digit.repeat(64);
const OLD_BATCHES = ['1', '2', '3', '4'].map(batch);
const NEW_BATCHES = ['a', 'b', 'c', 'd'].map(batch);

function rungMembers(batches: readonly (string | null)[]): Profile[] {
  return DEFAULT_ABR_RUNGS.map((rung, index) =>
    makeProfile({
      name: `${POOL.name}-${rung}`,
      kind: 'custom',
      components: ['bee-uploader'],
      port_slot: 2 + index,
      group_id: POOL.id,
      stamp_id: batches[index] ?? null,
    }),
  );
}

function poolString(batches: readonly string[], host = PUBLISHER_HOST): string {
  return beePublishersValue(
    DEFAULT_ABR_RUNGS.map((rung, index) => ({
      rungName: rung,
      url: `http://${host}:${10005 + (2 + index) * 10}`,
      batchId: batches[index]!,
    })),
  );
}

function stage(beePublishers: string): Profile {
  return makeProfile({
    name: STAGE,
    kind: 'abr-uploader',
    port_slot: 1,
    status: 'STOPPED',
    bee_publishers: beePublishers,
  });
}

function harness(rows: readonly Profile[], guard: (value: string) => Promise<string | null> = async () => null) {
  writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');
  const built = orchestratorHarness(rows);
  const poolStrings = new StagePoolStrings({
    profiles: built.profiles.asRepository(),
    groups: { list: async () => [POOL] },
    publisherHost: async () => PUBLISHER_HOST,
    guard,
  });
  built.orchestrator.setPoolStrings((profile) => poolStrings.withCurrentBatches(profile));
  return { ...built, poolStrings };
}

const writtenPublishers = () =>
  /^BEE_PUBLISHERS=(.*)$/m.exec(readFileSync(join(root, `.env.${STAGE}`), 'utf8'))?.[1] ?? null;

describe('a stage whose rungs came from a pool on this manager', () => {
  it('deploys with the batches its pool holds now, not the ones it was created with', async () => {
    const stored = stage(poolString(OLD_BATCHES));
    const { orchestrator, profiles } = harness([stored, ...rungMembers(NEW_BATCHES)]);

    await orchestrator.startDeploy(stored, undefined);

    assert.equal(writtenPublishers(), poolString(NEW_BATCHES));
    assert.equal(profiles.rows.get(STAGE)?.bee_publishers, poolString(NEW_BATCHES), 'the stored copy shows them too');
  });

  it('refuses the deploy when a rung of its pool has no batch, naming the rung', async () => {
    const stored = stage(poolString(OLD_BATCHES));
    const { orchestrator, profiles, runner } = harness([stored, ...rungMembers([...NEW_BATCHES.slice(0, 3), null])]);

    await assert.rejects(orchestrator.startDeploy(stored, undefined), (err: unknown) => {
      assert.ok(err instanceof ProfileConfigError);
      assert.match(err.message, /1080p: no postage batch set on this rung yet/);
      return true;
    });
    assert.equal(runner.runs.length, 0, 'nothing is started on a broken ladder');
    assert.equal(profiles.rows.get(STAGE)?.bee_publishers, poolString(OLD_BATCHES));
  });

  it('refuses the deploy with the pool string guard’s own sentence', async () => {
    const stored = stage(poolString(OLD_BATCHES));
    const refusal = 'this pool string names the catalogue batch';
    const { orchestrator, runner } = harness([stored, ...rungMembers(NEW_BATCHES)], async (value) =>
      value === poolString(NEW_BATCHES) ? refusal : null,
    );

    await assert.rejects(orchestrator.startDeploy(stored, undefined), (err: unknown) => {
      assert.ok(err instanceof ProfileConfigError);
      assert.match(err.message, new RegExp(refusal));
      return true;
    });
    assert.equal(runner.runs.length, 0);
  });

  it('takes a rung’s new batch into its stored copy when the rung is set to it', async () => {
    const stored = stage(poolString(OLD_BATCHES));
    const profiles = new InMemoryProfiles([stored, ...rungMembers(OLD_BATCHES)]);
    const poolStrings = new StagePoolStrings({
      profiles: profiles.asRepository(),
      groups: { list: async () => [POOL] },
      publisherHost: async () => PUBLISHER_HOST,
    });
    const stamps = new StampService(profiles.asRepository(), new FakeContainers().asRepository(), new EventBus());
    stamps.setAfterStampSet((name) => poolStrings.refreshStagesOf(name));

    await stamps.setStamp('abr-720p', NEW_BATCHES[2]!);

    const expected = [OLD_BATCHES[0]!, OLD_BATCHES[1]!, NEW_BATCHES[2]!, OLD_BATCHES[3]!];
    assert.equal(profiles.rows.get(STAGE)?.bee_publishers, poolString(expected));
  });
});

describe('a batch bought on a rung of its pool', () => {
  it('reaches the stage’s stored pool string once the batch is usable', async () => {
    const bought = batch('e');
    const stored = stage(poolString(OLD_BATCHES));
    const profiles = new InMemoryProfiles([stored, ...rungMembers(OLD_BATCHES)]);
    const poolStrings = new StagePoolStrings({
      profiles: profiles.asRepository(),
      groups: { list: async () => [POOL] },
      publisherHost: async () => PUBLISHER_HOST,
    });
    const client = {
      buyStamp: async () => ({ batchID: bought }),
      getStamp: async () => ({ usable: true }),
    } as unknown as BeeClient;
    const stamps = new StampService(
      profiles.asRepository(),
      new FakeContainers().asRepository(),
      new EventBus(),
      () => client,
      undefined,
      undefined,
      async () => {},
    );
    stamps.setAfterStampSet((name) => poolStrings.refreshStagesOf(name));

    await stamps.buyStamp('abr-720p', { amount: '1000000000', depth: 23, immutable: true });

    const expected = poolString([OLD_BATCHES[0]!, OLD_BATCHES[1]!, bought, OLD_BATCHES[3]!]);
    const deadline = Date.now() + 5_000;
    while (profiles.rows.get(STAGE)?.bee_publishers !== expected && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    assert.equal(profiles.rows.get(STAGE)?.bee_publishers, expected);
  });
});

describe('a stage whose pool string was pasted from elsewhere', () => {
  it('deploys the string as it was saved, and keeps it', async () => {
    const pasted = poolString(OLD_BATCHES, '198.51.100.7');
    const stored = stage(pasted);
    const { orchestrator, profiles } = harness([stored, ...rungMembers(NEW_BATCHES)]);

    await orchestrator.startDeploy(stored, undefined);

    assert.equal(writtenPublishers(), pasted);
    assert.equal(profiles.rows.get(STAGE)?.bee_publishers, pasted);
  });
});
