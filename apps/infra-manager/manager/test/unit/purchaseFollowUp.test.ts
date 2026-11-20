/**
 * The parts of the manager that put a batch bought through the funding API to use, behind the ports of
 * `purchaseFollowUpPorts.ts`: a rung's batch set as the Buy form sets one, one look at a stage that moves it one step,
 * and the catalogue batch designated as a move and released.
 *
 * Unit test, no database, no Docker and no Bee node. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  ABR_NODE_POOL_GROUP_KIND,
  beePublishersValue,
  type DeploymentSettingEntry,
  type DeploymentSettingsCatalog,
  type IngestHealthReading,
  INGEST_NOT_SRS,
  INGEST_READ,
  PURCHASE_LIVE_READ_GAP_MS,
  RTMP_INGEST_NO_REPORTS,
  SRT_INGEST_MEASURED,
  SRT_INGEST_NO_REPORTS,
  type StampHealth,
  type StampState,
} from '@streaming-infra-manager/common';

import type { BeeStamp } from '../../src/domain/BeeClient.js';
import { ProfileBusyError, ProfileConfigError } from '../../src/domain/errors/index.js';
import { CatalogueDesignationService } from '../../src/domain/stages/CatalogueDesignationService.js';
import {
  DeploymentSettingsBeyondError,
  EngineSettingsRefusedError,
} from '../../src/domain/settings/DeploymentSettingsService.js';
import {
  namesAnAddress,
  PURCHASE_BATCH_KEYS,
  PurchaseFollowUpError,
  purchaseFollowUpPorts,
  type PurchaseFollowUpPorts,
  type PurchaseFollowUpPortsDeps,
} from '../../src/domain/stages/purchaseFollowUp.js';
import { StagePoolStrings, type StageFollower } from '../../src/domain/stages/StagePoolStrings.js';
import type { DeploymentGroup, Profile } from '../../src/types/index.js';
import { InMemoryCatalogueDesignation } from '../support/InMemoryCatalogueDesignation.js';
import { makeProfile } from '../support/profileFixtures.js';

const OLD = '1'.repeat(64);
const BOUGHT = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);
const REQUEST = '0b6f3c1e-2d4a-4f8b-9c7d-5e6f7a8b9c0d';

const RUNG = makeProfile({ name: 'pool-360p', kind: 'custom', components: ['bee-uploader'], stamp_id: OLD });

/** A stage in the shape the look reads, RUNNING, with its own instance id. */
function stageProfile(name: string, over: Partial<Profile> = {}): Profile {
  return makeProfile({ name, kind: 'abr-uploader', status: 'RUNNING', instance_id: `${name}-instance`, ...over });
}

/** A settings list whose batch key is at `state`, with the running value and the next deploy's value as given. */
function catalogOf(over: {
  running?: boolean;
  key?: string;
  state?: DeploymentSettingEntry['running'];
  runningValue?: string | null;
  value?: string | null;
  otherKeysBehind?: string[];
}): DeploymentSettingsCatalog {
  const key = over.key ?? 'BEE_PUBLISHERS';
  const state = over.state ?? 'differs';
  const entry = {
    key,
    running: state,
    runningValue: over.runningValue ?? null,
    value: over.value === undefined ? `360p@http://192.0.2.10:10025<${BOUGHT}>` : over.value,
  } as DeploymentSettingEntry;
  const behind = [...(state === 'differs' ? [key] : []), ...(over.otherKeysBehind ?? [])];
  return {
    entries: [entry],
    drift: { keys: behind, services: ['bee-uploader'], fullRedeploy: false },
    running: over.running ?? true,
  } as unknown as DeploymentSettingsCatalog;
}

const idle: IngestHealthReading = {
  state: INGEST_READ,
  windowSeconds: 60,
  srt: { state: SRT_INGEST_NO_REPORTS },
  rtmp: { state: RTMP_INGEST_NO_REPORTS },
};
const live = {
  ...idle,
  srt: { state: SRT_INGEST_MEASURED, connections: 1 },
} as unknown as IngestHealthReading;
const notSrs: IngestHealthReading = { state: INGEST_NOT_SRS, windowSeconds: 60 };

/** The fakes behind the rung and stage ports, which each test sets up as it needs. */
class World {
  profiles: Profile[] = [];
  states = new Map<string, StampState>();
  set: string[] = [];
  followers = new Map<string, StageFollower[] | null>();
  /** A stage's settings list, or the lists its reads answer in turn, the last one from then on. */
  catalogs = new Map<string, DeploymentSettingsCatalog | DeploymentSettingsCatalog[]>();
  applied: string[] = [];
  applyError: Error | null = null;
  /** The keys each Apply was told it may roll out. */
  applyOnly: (readonly string[] | null)[] = [];
  readings: IngestHealthReading[] = [];
  pauses: number[] = [];
  clock = 1_000;

  deps(catalogue: PurchaseFollowUpPortsDeps['catalogue'] = unusedCatalogue): PurchaseFollowUpPortsDeps {
    return {
      profiles: {
        findByName: async (name) => this.profiles.find((profile) => profile.name === name) ?? null,
        list: async () => this.profiles.map((profile) => ({ ...profile })),
      },
      stamps: {
        stampHealthFor: async (_profile, stampId) =>
          ({ state: stampId ? (this.states.get(stampId) ?? 'active') : 'none' }) as StampHealth,
        setStamp: async (name, stampId) => {
          this.set.push(`${name}:${stampId}`);
          const profile = this.profiles.find((candidate) => candidate.name === name)!;
          profile.stamp_id = stampId;
          return profile as never;
        },
      },
      poolStrings: { followersOf: async (name) => this.followers.get(name) ?? null },
      settings: {
        catalog: async (name) => {
          const listed = this.catalogs.get(name)!;
          if (!Array.isArray(listed)) return listed;
          return listed.length > 1 ? listed.shift()! : listed[0]!;
        },
        apply: async (name, instanceId, _username, options) => {
          this.applyOnly.push(options?.only ?? null);
          if (this.applyError) throw this.applyError;
          this.applied.push(`${name}:${instanceId}`);
          const profile = this.profiles.find((candidate) => candidate.name === name)!;
          profile.status = 'DEPLOYING';
          return { recreated: ['bee-uploader'] };
        },
      },
      ingest: { read: async () => this.readings.shift() ?? idle },
      catalogue,
      pause: async (ms) => {
        this.pauses.push(ms);
      },
      now: () => this.clock,
    };
  }

  ports(catalogue?: PurchaseFollowUpPortsDeps['catalogue']): PurchaseFollowUpPorts {
    return purchaseFollowUpPorts(this.deps(catalogue));
  }
}

const unusedCatalogue: PurchaseFollowUpPortsDeps['catalogue'] = {
  read: async () => assert.fail('the catalogue is not asked'),
  designate: async () => assert.fail('the catalogue is not asked'),
  release: async () => assert.fail('the catalogue is not asked'),
};

let world: World;

beforeEach(() => {
  world = new World();
});

describe("a rung's batch", () => {
  it('reads the batch set on the deployment, with its verdict, and none where none is set', async () => {
    world.profiles = [{ ...RUNG, stamp_id: `0x${OLD.toUpperCase()}` }, makeProfile({ name: 'bare', stamp_id: null })];
    world.states.set(`0x${OLD.toUpperCase()}`, 'expired');
    const { rungs } = world.ports();

    assert.deepEqual(await rungs.current('pool-360p'), { batchId: OLD, state: 'expired' });
    assert.deepEqual(await rungs.current('bare'), { batchId: null, state: 'none' });
    await assert.rejects(rungs.current('missing'), /There is no deployment called missing/);
  });

  it('is set as the Buy form sets one, and answers the stages that name the rung, a pasted string not following', async () => {
    world.profiles = [{ ...RUNG }];
    world.states.set(OLD, 'expired');
    world.followers.set('pool-360p', [
      { stage: stageProfile('main'), following: true },
      { stage: stageProfile('pasted'), following: false },
    ]);

    const followers = await world
      .ports()
      .rungs.set({ profileName: 'pool-360p', batchId: `0x${BOUGHT}`, requestId: REQUEST });

    assert.deepEqual(world.set, [`pool-360p:${BOUGHT}`]);
    assert.deepEqual(followers, [
      { stageId: 'main-instance', name: 'main', following: true },
      { stageId: 'pasted-instance', name: 'pasted', following: false },
    ]);
  });

  it('changes nothing for a batch set already, and answers the same stages', async () => {
    world.profiles = [{ ...RUNG, stamp_id: BOUGHT }];
    world.followers.set('pool-360p', [{ stage: stageProfile('main'), following: true }]);

    const followers = await world.ports().rungs.set({ profileName: 'pool-360p', batchId: BOUGHT, requestId: REQUEST });

    assert.deepEqual(world.set, []);
    assert.deepEqual(followers, [{ stageId: 'main-instance', name: 'main', following: true }]);
  });

  it('leaves a batch that works, set by another hand meanwhile, and rejects with a sentence', async () => {
    world.profiles = [{ ...RUNG, stamp_id: OTHER }];
    world.states.set(OTHER, 'active');

    await assert.rejects(
      world.ports().rungs.set({ profileName: 'pool-360p', batchId: BOUGHT, requestId: REQUEST }),
      /^PurchaseFollowUpError: The bought batch was not set on pool-360p, because batch cccccccc… is set there now\. The batch set on this node still pays for uploads/,
    );
    assert.deepEqual(world.set, []);
  });

  it('answers a stage that uploads to its own Bee node as its only stage, following', async () => {
    world.profiles = [stageProfile('single', { stamp_id: null })];

    const followers = await world.ports().rungs.set({ profileName: 'single', batchId: BOUGHT, requestId: REQUEST });

    assert.deepEqual(world.set, [`single:${BOUGHT}`]);
    assert.deepEqual(followers, [{ stageId: 'single-instance', name: 'single', following: true }]);
  });
});

describe('the stages that name a rung', () => {
  const POOL: DeploymentGroup = {
    id: 7,
    name: 'abr',
    size: 1,
    kind: ABR_NODE_POOL_GROUP_KIND,
    created_at: new Date(0),
  };
  const HOST = '192.0.2.10';
  const member = makeProfile({
    name: 'abr-360p',
    kind: 'custom',
    components: ['bee-uploader'],
    port_slot: 2,
    group_id: POOL.id,
    stamp_id: BOUGHT,
  });
  const memberUrl = `http://${HOST}:${10005 + 2 * 10}`;
  const own = beePublishersValue([{ rungName: '360p', url: memberUrl, batchId: BOUGHT }]);
  const pasted = beePublishersValue([
    { rungName: '360p', url: memberUrl, batchId: BOUGHT },
    { rungName: '720p', url: 'http://198.51.100.7:1633', batchId: OTHER },
  ]);

  function poolStrings(profiles: Profile[]): StagePoolStrings {
    return new StagePoolStrings({
      profiles: { list: async () => profiles, updatePoolString: async () => null },
      groups: { list: async () => [POOL] },
      publisherHost: async () => HOST,
    });
  }

  it("answers the pool's own string as following and a pasted one as not, by name, and leaves the rest out", async () => {
    const profiles = [
      member,
      stageProfile('zeta', { bee_publishers: own }),
      stageProfile('alpha', { bee_publishers: pasted }),
      stageProfile('elsewhere', { bee_publishers: `360p@http://198.51.100.9:1633<${OTHER}>` }),
      stageProfile('plain'),
    ];

    const followers = await poolStrings(profiles).followersOf('abr-360p');

    assert.deepEqual(
      followers?.map(({ stage, following }) => [stage.name, following]),
      [
        ['alpha', false],
        ['zeta', true],
      ],
    );
  });

  it('answers null for a deployment that is no rung of a pool', async () => {
    assert.equal(await poolStrings([member, stageProfile('plain')]).followersOf('plain'), null);
  });
});

describe('one look at a stage', () => {
  const look = (over: Partial<{ force: boolean; retryFailed: boolean; stageId: string }> = {}) =>
    world.ports().stages.look({ stageId: 'main-instance', batchId: BOUGHT, force: false, retryFailed: false, ...over });

  beforeEach(() => {
    world.profiles = [{ ...RUNG, stamp_id: BOUGHT }, stageProfile('main')];
    world.followers.set('pool-360p', [{ stage: stageProfile('main'), following: true }]);
    world.catalogs.set('main', catalogOf({}));
  });

  it('answers applied once the running uploader pays with the batch, whoever applied it', async () => {
    world.catalogs.set('main', catalogOf({ state: 'same', runningValue: `360p@http://192.0.2.10:10025<${BOUGHT}>` }));
    assert.deepEqual(await look(), { apply: 'applied', message: null });

    world.catalogs.set('main', catalogOf({ key: 'STAMP', state: 'same', runningValue: BOUGHT, value: BOUGHT }));
    assert.equal((await look()).apply, 'applied');
    assert.deepEqual(world.applied, []);
  });

  it('answers stopped for a stage that does not run, and for one no longer on the manager', async () => {
    world.catalogs.set('main', catalogOf({ running: false, state: 'not-running' }));
    assert.equal((await look()).apply, 'stopped');

    assert.deepEqual(await look({ stageId: 'gone-instance' }), {
      apply: 'stopped',
      message: 'The stage is no longer on this manager.',
    });
    assert.deepEqual(world.applied, []);
  });

  it('answers applying while a deploy of the stage is under way', async () => {
    world.profiles[1]!.status = 'DEPLOYING';
    assert.deepEqual(await look(), { apply: 'applying', message: null });
  });

  it("answers not_following for a stage whose pool string is not the pool's own", async () => {
    world.followers.set('pool-360p', [{ stage: stageProfile('main'), following: false }]);
    assert.equal((await look()).apply, 'not_following');
    assert.deepEqual(world.applied, []);
  });

  it('answers waiting_settings, naming the other keys behind, and a restart changes nothing of it', async () => {
    world.catalogs.set('main', catalogOf({ otherKeysBehind: ['SRT_LATENCY'] }));

    for (const force of [false, true]) {
      assert.deepEqual(await look({ force }), {
        apply: 'waiting_settings',
        message:
          'Other saved settings wait for an Apply beside the batch: SRT_LATENCY. Apply the stage in the manager.',
      });
    }
    assert.deepEqual(world.applied, []);
  });

  it('answers waiting_settings, and applies nothing, for a setting saved while the broadcast was read', async () => {
    for (const force of [false, true]) {
      world.applied = [];
      world.readings = [idle, idle];
      world.catalogs.set('main', [catalogOf({}), catalogOf({ otherKeysBehind: ['SRT_LATENCY'] })]);

      assert.deepEqual(await look({ force }), {
        apply: 'waiting_settings',
        message:
          'Other saved settings wait for an Apply beside the batch: SRT_LATENCY. Apply the stage in the manager.',
      });
      assert.deepEqual(world.applied, [], force ? 'restarted' : 'looked');
    }
  });

  it('starts the Apply once two readings 15 seconds apart find no broadcast', async () => {
    world.readings = [idle, idle];

    assert.deepEqual(await look(), { apply: 'applying', message: null });
    assert.deepEqual(world.pauses, [PURCHASE_LIVE_READ_GAP_MS]);
    assert.deepEqual(world.applied, ['main:main-instance']);
    assert.deepEqual(world.applyOnly, [PURCHASE_BATCH_KEYS], 'the Apply may roll out the batch keys alone');
  });

  it('answers waiting_settings when the Apply finds another setting saved after the look read the drift', async () => {
    world.applyError = new DeploymentSettingsBeyondError('main', ['SRT_LATENCY']);

    for (const force of [false, true]) {
      assert.deepEqual(await look({ force }), {
        apply: 'waiting_settings',
        message:
          'Other saved settings wait for an Apply beside the batch: SRT_LATENCY. Apply the stage in the manager.',
      });
    }
    assert.deepEqual(world.applied, []);
  });

  it('waits for a broadcast seen in either reading, and a restart passes over it', async () => {
    world.readings = [idle, live];
    assert.deepEqual(await look(), { apply: 'waiting_live', message: null });

    world.readings = [live];
    assert.equal((await look()).apply, 'waiting_live');
    assert.deepEqual(world.applied, []);

    world.readings = [live, live];
    assert.equal((await look({ force: true })).apply, 'applying');
    assert.deepEqual(world.applied, ['main:main-instance']);
  });

  it('answers waiting_unknown when a reading cannot tell, and a restart passes over it', async () => {
    world.readings = [idle, notSrs];
    assert.equal((await look()).apply, 'waiting_unknown');
    assert.deepEqual(world.applied, []);

    assert.equal((await look({ force: true })).apply, 'applying');
    assert.deepEqual(world.applied, ['main:main-instance']);
  });

  it('answers failed for an Apply it started that ended without the batch, until asked to check again', async () => {
    const ports = world.ports();
    const once = (retryFailed = false) =>
      ports.stages.look({ stageId: 'main-instance', batchId: BOUGHT, force: false, retryFailed });
    assert.equal((await once()).apply, 'applying');

    // The deploy ended in an error after the Apply started.
    world.clock = 5_000;
    Object.assign(world.profiles[1]!, {
      status: 'ERROR',
      last_error: 'the uploader exited',
      last_error_at: new Date(2_000),
    });
    assert.deepEqual(await once(), { apply: 'failed', message: 'The Apply failed. The manager’s log says why.' });
    assert.equal((await once()).apply, 'failed');
    assert.deepEqual(world.applied, ['main:main-instance']);

    assert.equal((await once(true)).apply, 'applying');
    assert.deepEqual(world.applied, ['main:main-instance', 'main:main-instance']);
  });

  it("answers applying when another purchase's deploy of the stage started first, and applied once it brought the batch, without an Apply of its own", async () => {
    // Two rungs of one pool, each with a batch of its own purchase; the other rung's Apply claimed the stage between
    // this look's reading and its Apply.
    const SECOND = 'd'.repeat(64);
    world.profiles.push(
      makeProfile({ name: 'pool-720p', kind: 'custom', components: ['bee-uploader'], stamp_id: SECOND }),
    );
    world.followers.set('pool-720p', [{ stage: stageProfile('main'), following: true }]);
    world.applyError = new ProfileBusyError('main', 'DEPLOYING');
    const ports = world.ports();
    const once = () =>
      ports.stages.look({ stageId: 'main-instance', batchId: BOUGHT, force: false, retryFailed: false });

    assert.deepEqual(await once(), { apply: 'applying', message: null });
    assert.deepEqual(world.applied, []);

    // While that deploy runs.
    world.profiles[1]!.status = 'DEPLOYING';
    assert.deepEqual(await once(), { apply: 'applying', message: null });

    // That deploy wrote the pool's current string, which carries both rungs' new batches.
    world.applyError = null;
    world.profiles[1]!.status = 'RUNNING';
    const both = beePublishersValue([
      { rungName: '360p', url: 'http://192.0.2.10:10025', batchId: BOUGHT },
      { rungName: '720p', url: 'http://192.0.2.10:10035', batchId: SECOND },
    ]);
    world.catalogs.set('main', catalogOf({ state: 'same', runningValue: both, value: both }));
    assert.deepEqual(await once(), { apply: 'applied', message: null });
    assert.deepEqual(world.applied, [], 'no second Apply');
  });

  it('keeps the failed Apply of each purchase that follows the stage, so a deploy that keeps failing is not applied again', async () => {
    const SECOND = 'd'.repeat(64);
    world.profiles.push(
      makeProfile({ name: 'pool-720p', kind: 'custom', components: ['bee-uploader'], stamp_id: SECOND }),
    );
    world.followers.set('pool-720p', [{ stage: stageProfile('main'), following: true }]);
    const both = beePublishersValue([
      { rungName: '360p', url: 'http://192.0.2.10:10025', batchId: BOUGHT },
      { rungName: '720p', url: 'http://192.0.2.10:10035', batchId: SECOND },
    ]);
    world.catalogs.set('main', catalogOf({ value: both }));
    const ports = world.ports();
    const lookFor = (batchId: string) =>
      ports.stages.look({ stageId: 'main-instance', batchId, force: false, retryFailed: false });
    /** The deploy an Apply started ends in an error. */
    const failDeploy = () => {
      world.clock += 1_000;
      Object.assign(world.profiles[1]!, {
        status: 'ERROR',
        last_error: 'the uploader exited',
        last_error_at: new Date(world.clock),
      });
    };

    assert.equal((await lookFor(BOUGHT)).apply, 'applying');
    failDeploy();
    assert.equal((await lookFor(SECOND)).apply, 'applying');
    failDeploy();

    for (let round = 0; round < 3; round += 1) {
      assert.equal((await lookFor(BOUGHT)).apply, 'failed');
      assert.equal((await lookFor(SECOND)).apply, 'failed');
    }
    assert.equal(world.applied.length, 2, 'one Apply for each purchase, none after');
  });

  it("passes on the engine settings refusal's own sentence, which says what to fix, when it names no address", async () => {
    world.applyError = new EngineSettingsRefusedError('main', 'HLS_FRAGMENT must be at least 1 second on this host.');
    assert.deepEqual(await look(), {
      apply: 'failed',
      message: 'The Apply did not start: HLS_FRAGMENT must be at least 1 second on this host.',
    });
  });

  it('keeps the engine settings refusal plain when it names an address, and any other refusal plain', async () => {
    const plain = { apply: 'failed', message: 'The Apply did not start. The manager’s log says why.' };
    for (const error of [
      new EngineSettingsRefusedError('main', 'The SRS API at http://203.0.113.9:1985 did not answer.'),
      new EngineSettingsRefusedError('main', 'The host deploy@stage.example.org refuses the setting.'),
      new ProfileConfigError('main', 'The deploy root is missing.'),
    ]) {
      world.applyError = error;
      assert.deepEqual(
        await world
          .ports()
          .stages.look({ stageId: 'main-instance', batchId: BOUGHT, force: false, retryFailed: false }),
        plain,
        error.message,
      );
    }
  });

  it('answers failed, without the error that can name a host, for an Apply that did not start', async () => {
    world.applyError = new Error('ssh: connect to host 203.0.113.9 port 22: Connection refused');
    assert.deepEqual(await look(), {
      apply: 'failed',
      message: 'The Apply did not start. The manager’s log says why.',
    });
  });

  it("answers failed, without the deploy's error that can name a host, for an Apply that failed", async () => {
    const ports = world.ports();
    const once = () =>
      ports.stages.look({ stageId: 'main-instance', batchId: BOUGHT, force: false, retryFailed: false });
    assert.equal((await once()).apply, 'applying');
    world.clock = 5_000;
    Object.assign(world.profiles[1]!, {
      status: 'ERROR',
      last_error: 'rsync to deploy@203.0.113.9:/srv/stage failed',
      last_error_at: new Date(5_000),
    });

    const failed = await once();
    assert.equal(failed.apply, 'failed');
    assert.doesNotMatch(failed.message ?? '', /203\.0\.113\.9/);
  });

  it("answers failed when the stage's saved settings do not name the batch", async () => {
    world.catalogs.set('main', catalogOf({ value: `360p@http://192.0.2.10:10025<${OLD}>` }));
    assert.equal((await look()).apply, 'failed');
    assert.deepEqual(world.applied, []);
  });
});

describe('a text that names an address', () => {
  it('is any IPv4 or IPv6 address, URL, user@host, host:port or dotted host name, and not a plain sentence', () => {
    for (const text of [
      'at 203.0.113.9',
      'at [2001:db8::1]',
      'at 2001:db8::1',
      'from http://node/api',
      'as deploy@stage',
      'on stage-host:1633',
      'on stage.example.org',
    ]) {
      assert.equal(namesAnAddress(text), true, text);
    }
    for (const text of [
      'HLS_FRAGMENT must be at least 1 second on this host.',
      'The segment length is 2 seconds, over the ceiling of 1.',
    ]) {
      assert.equal(namesAnAddress(text), false, text);
    }
  });
});

describe('what a port rejects with', () => {
  const ADDRESS = /203\.0\.113\.9|198\.51\.100\.4/;

  it('is a plain sentence for a failure that can name a host, and its own sentence otherwise', async () => {
    world.profiles = [{ ...RUNG }];
    world.states.set(OLD, 'expired');
    const deps = world.deps({
      read: async () => {
        throw new Error('connect ECONNREFUSED 198.51.100.4:5432');
      },
      designate: async () => assert.fail('not reached'),
      release: async () => assert.fail('not reached'),
    });
    deps.stamps.setStamp = async () => {
      throw new Error('connect ECONNREFUSED 203.0.113.9:5432');
    };
    deps.profiles.list = async () => {
      throw new Error('connect ECONNREFUSED 203.0.113.9:5432');
    };
    const ports = purchaseFollowUpPorts(deps);

    const rejections: [Promise<unknown>, string][] = [
      [
        ports.rungs.set({ profileName: 'pool-360p', batchId: BOUGHT, requestId: REQUEST }),
        'The bought batch could not be set on its deployment. The manager’s log says why.',
      ],
      [
        ports.stages.look({ stageId: 'main-instance', batchId: BOUGHT, force: false, retryFailed: false }),
        'The stage could not be read. The manager’s log says why.',
      ],
      [ports.catalogue.current('catalogue'), 'The catalogue batch could not be read. The manager’s log says why.'],
      [
        ports.catalogue.designate({ profileName: 'catalogue', batchId: BOUGHT, requestId: REQUEST }),
        'The bought batch could not be designated as the catalogue batch. The manager’s log says why.',
      ],
      [
        ports.catalogue.release({ batchId: BOUGHT, previousBatchId: OLD, requestId: REQUEST }),
        'The previous catalogue batch could not be released. The manager’s log says why.',
      ],
    ];
    for (const [rejection, sentence] of rejections) {
      await assert.rejects(rejection, (err: unknown) => {
        assert.ok(err instanceof PurchaseFollowUpError);
        assert.equal(err.message, sentence);
        assert.doesNotMatch(err.message, ADDRESS);
        return true;
      });
    }

    await assert.rejects(ports.rungs.current('missing'), {
      name: 'PurchaseFollowUpError',
      message: 'There is no deployment called missing on this manager.',
    });
  });
});

describe('the catalogue batch', () => {
  const NODE = 'catalogue';
  let store: InMemoryCatalogueDesignation;
  let ports: PurchaseFollowUpPorts;

  const stampOf = (batchId: string): BeeStamp => ({
    batchID: batchId,
    utilization: 0,
    usable: true,
    depth: 20,
    amount: '48000000',
    bucketDepth: 16,
    blockNumber: 39_000_000,
    immutableFlag: true,
    exists: true,
    batchTTL: 90 * 86_400,
  });

  beforeEach(() => {
    world.profiles = [makeProfile({ name: NODE, kind: 'custom', components: ['bee-uploader'] })];
    store = new InMemoryCatalogueDesignation();
    const service = new CatalogueDesignationService({
      store,
      profiles: {
        findByName: async (name) => world.profiles.find((profile) => profile.name === name) ?? null,
        list: async () => world.profiles,
      },
      groupKindOf: async () => 'standard',
      heldBatch: async (_name, batchId) => stampOf(batchId),
      status: () => ({ reading: null, previousReading: null, lastPush: null }),
      changed: () => {},
    });
    ports = world.ports(service);
    // A purchase replaces a catalogue batch that no longer pays.
    world.states.set(OLD, 'expired');
  });

  it('reads the designated batch on its node with its verdict, and none on another node or with none designated', async () => {
    assert.deepEqual(await ports.catalogue.current(NODE), { batchId: null, state: 'none' });

    await ports.catalogue.designate({ profileName: NODE, batchId: OLD, requestId: REQUEST });
    world.states.set(OLD, 'expired');

    assert.deepEqual(await ports.catalogue.current(NODE), { batchId: OLD, state: 'expired' });
    assert.deepEqual(await ports.catalogue.current('elsewhere'), { batchId: null, state: 'none' });
  });

  it('designates a first batch, then a bought one as a move, logged as the purchase, and answers the same again', async () => {
    assert.deepEqual(await ports.catalogue.designate({ profileName: NODE, batchId: OLD, requestId: REQUEST }), {
      previousBatchId: null,
    });

    const moved = await ports.catalogue.designate({ profileName: NODE, batchId: `0x${BOUGHT}`, requestId: REQUEST });
    assert.deepEqual(moved, { previousBatchId: OLD });
    assert.equal(store.row.batchId, BOUGHT);
    assert.equal(store.row.movingFromBatchId, OLD);
    assert.equal(store.row.moveStartedBy, `the batch purchase ${REQUEST}`);
    const revision = store.row.revision;

    assert.deepEqual(await ports.catalogue.designate({ profileName: NODE, batchId: BOUGHT, requestId: REQUEST }), {
      previousBatchId: OLD,
    });
    assert.equal(store.row.revision, revision, 'designated again, nothing written');
  });

  it('leaves a catalogue batch that works, designated meanwhile, and rejects with a sentence', async () => {
    await ports.catalogue.designate({ profileName: NODE, batchId: OLD, requestId: REQUEST });
    world.states.set(OLD, 'active');
    const revision = store.row.revision;

    await assert.rejects(
      ports.catalogue.designate({ profileName: NODE, batchId: BOUGHT, requestId: REQUEST }),
      /^PurchaseFollowUpError: The bought batch was not designated, because batch 11111111… is the catalogue batch now\. The catalogue batch still pays for uploads\./,
    );
    assert.equal(store.row.batchId, OLD);
    assert.equal(store.row.revision, revision, 'nothing written');

    // Once it has expired, the bought batch moves the catalogue off it.
    world.states.set(OLD, 'expired');
    assert.deepEqual(await ports.catalogue.designate({ profileName: NODE, batchId: BOUGHT, requestId: REQUEST }), {
      previousBatchId: OLD,
    });
  });

  it("rejects with the designation's own sentence while another move is pending", async () => {
    await ports.catalogue.designate({ profileName: NODE, batchId: OLD, requestId: REQUEST });
    await ports.catalogue.designate({ profileName: NODE, batchId: OTHER, requestId: REQUEST });
    world.states.set(OTHER, 'expired');

    await assert.rejects(
      ports.catalogue.designate({ profileName: NODE, batchId: BOUGHT, requestId: REQUEST }),
      (err: unknown) => err instanceof Error && /release/i.test(err.message),
    );
    assert.equal(store.row.batchId, OTHER);
  });

  it('releases the batch the move left once, resolves again after, and refuses once the catalogue moved on', async () => {
    await ports.catalogue.designate({ profileName: NODE, batchId: OLD, requestId: REQUEST });
    await ports.catalogue.designate({ profileName: NODE, batchId: BOUGHT, requestId: REQUEST });

    await ports.catalogue.release({ batchId: BOUGHT, previousBatchId: OLD, requestId: REQUEST });
    assert.equal(store.row.movingFromBatchId, null);
    assert.equal(store.row.releasedBy, `the batch purchase ${REQUEST}`);
    await ports.catalogue.release({ batchId: BOUGHT, previousBatchId: OLD, requestId: REQUEST });

    world.states.set(BOUGHT, 'gone');
    await ports.catalogue.designate({ profileName: NODE, batchId: OTHER, requestId: REQUEST });
    await assert.rejects(
      ports.catalogue.release({ batchId: BOUGHT, previousBatchId: OLD, requestId: REQUEST }),
      /The catalogue has moved on from batch bbbbbbbb… since/,
    );
  });
});
