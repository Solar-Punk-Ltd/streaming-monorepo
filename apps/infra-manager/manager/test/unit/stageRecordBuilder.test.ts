/**
 * The stage record the manager pushes into the web2 admin for one deployment
 * that runs a stream uploader: every field as the contract takes it, the owner
 * derived from the stream key and never the key, the admin token by its sha256
 * and its kind, the SRT passphrase as the one secret the admin needs for the
 * OBS panel, and no key and no token anywhere in it.
 *
 * Unit test, no database, no network. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  addressOfStreamKey,
  NO_PUBLIC_INGEST_HOST,
  chequebookHealthFrom,
  chequebookHealthPayload,
  type ChequebookSummary,
  stampHealthFrom,
  type StampHealth,
  type UploaderHealthReading,
} from '@streaming-infra-manager/common';
import { stageRecordSchema } from '@streaming-monorepo/contracts';

import type { NextDeployEnv } from '../../src/domain/DeploymentOrchestrator.js';
import {
  SINGLE_RUNG_NAME,
  StageRecordBuilder,
  type StageReadings,
} from '../../src/domain/stages/StageRecordBuilder.js';
import type { StackVersionRecord } from '../../src/domain/versions/StackVersionRepository.js';
import type { Profile, ProfileWithContainers } from '../../src/types/index.js';
import { makeProfile } from '../support/profileFixtures.js';

const STAGE_ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const MANAGER_ID = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
/** Private key 1, which no one signs with. */
const STREAM_KEY = `0x${'0'.repeat(63)}1`;
const OWNER = addressOfStreamKey(STREAM_KEY)!.toLowerCase();
const SHARED_TOKEN = 'synthetic-shared-admin-token-0123456789abcdef';
const OWN_TOKEN = 'synthetic-own-admin-token-fedcba9876543210ab';
const PASSPHRASE = 'synthetic-passphrase-0123';
const RPC_ENDPOINT = 'https://rpc.example.org/v1/synthetic-rpc-key-0000';
const NODE_URL = 'http://192.0.2.30:10015';
const BATCH = 'b'.repeat(64);
const OBSERVED = new Date('2026-09-28T10:00:00.000Z');
const PLUR_PER_BZZ = 10n ** 16n;

const RUNG_BATCHES: Record<string, string> = {
  '360p': '1'.repeat(64),
  '480p': '2'.repeat(64),
  '720p': '3'.repeat(64),
  '1080p': '4'.repeat(64),
};
const POOL = ['1080p', '360p', '720p', '480p']
  .map((rung, index) => `${rung}@http://192.0.2.40:${10015 + index * 10}<${RUNG_BATCHES[rung]}>`)
  .join(' ');

function stage(over: Partial<ProfileWithContainers> = {}): ProfileWithContainers {
  return {
    ...makeProfile({ name: 'stage-one', kind: 'streamer', instance_id: STAGE_ID, stamp_id: BATCH }),
    containers: [
      { service: 'srs', ports: {}, buildId: null, buildCommit: null },
      { service: 'stream-uploader', ports: {}, buildId: null, buildCommit: null },
      { service: 'bee-uploader', ports: {}, buildId: null, buildCommit: null },
    ],
    pendingStamp: false,
    network_host: '192.0.2.10',
    ...over,
  };
}

const version = { id: 1, name: 'v3.4.0' } as StackVersionRecord;

function baseEnv(over: Record<string, string> = {}): Record<string, string> {
  return {
    STREAM_KEY,
    SRS_SRT_PORT: '10012',
    SRS_RTMP_PORT: '10013',
    SRT_PASSPHRASE: PASSPHRASE,
    ADMIN_API_URL: 'https://admin.example.org',
    ADMIN_API_TOKEN: SHARED_TOKEN,
    BEE_RPC_ENDPOINT: RPC_ENDPOINT,
    BEE_URL: NODE_URL,
    ...over,
  };
}

function summaryOf(availablePlur: bigint | null): ChequebookSummary {
  return {
    address: '0x' + 'c'.repeat(40),
    totalBalance: null,
    availableBalance: availablePlur?.toString() ?? null,
    totalSent: null,
    totalReceived: null,
    health: chequebookHealthPayload(
      chequebookHealthFrom(
        availablePlur === null
          ? null
          : { totalBalance: availablePlur.toString(), availableBalance: availablePlur.toString() },
        5n * 10n ** 15n,
      ),
    ),
  };
}

interface FakeReadingsOptions {
  env?: Record<string, string>;
  profiles?: Profile[];
  stamps?: Record<string, StampHealth>;
  chequebooks?: Record<string, ChequebookSummary>;
  uploader?: UploaderHealthReading | 'throws';
  nextEnvThrows?: boolean;
  /** Whether the next deploy's ADMIN_API_TOKEN is the one the manager generated for the deployment. */
  ownAdminToken?: boolean;
}

function readings(options: FakeReadingsOptions = {}): StageReadings & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async nextEnvFor(): Promise<Pick<NextDeployEnv, 'env' | 'version' | 'ownAdminToken'>> {
      if (options.nextEnvThrows) throw new Error('The version has no build yet.');
      return { env: options.env ?? baseEnv(), version, ownAdminToken: options.ownAdminToken ?? false };
    },
    async listProfiles() {
      return options.profiles ?? [];
    },
    async stampHealthFor(profile, stampId) {
      asked.push(`stamp ${profile.name}`);
      return options.stamps?.[stampId.replace(/^0x/, '')] ?? stampHealthFrom(stampId, null);
    },
    async chequebookSummary(name) {
      asked.push(`chequebook ${name}`);
      const summary = options.chequebooks?.[name];
      if (!summary) throw new Error('the node did not answer');
      return summary;
    },
    async uploaderHealth() {
      if (options.uploader === 'throws') throw new Error('unknown deployment');
      return options.uploader ?? { state: 'ok', reasons: [] };
    },
  };
}

function builder(options: FakeReadingsOptions = {}, publicHost = 'manager.example.org') {
  return new StageRecordBuilder(readings(options), {
    managerId: MANAGER_ID,
    publicHost,
    now: () => OBSERVED,
  });
}

const liveStamp = (batch: string, ttl = 30 * 86_400) =>
  stampHealthFrom(batch, [
    { batchID: batch, usable: true, batchTTL: ttl, depth: 22, bucketDepth: 16, utilization: 16, immutableFlag: true },
  ]);

async function built(options: FakeReadingsOptions = {}, profile = stage()) {
  const result = await builder(options).build(profile);
  assert.ok(result.ok, result.ok ? '' : result.problem);
  return result;
}

/** Every value a record holds, nested ones included, by its path, such as `ingest.srtPort` or `rungs.0.batchId`. */
function leavesOf(value: unknown, path: readonly string[] = []): Array<[string, string]> {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [[path.join('.'), String(value)]];
  }
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, inner]) => leavesOf(inner, [...path, key]));
}

describe('a stage record, field by field', () => {
  it('names the stage, the manager, the deployment and what it runs', async () => {
    const { record } = await built();
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.stageId, STAGE_ID);
    assert.equal(record.managerId, MANAGER_ID);
    assert.equal(record.name, 'stage-one');
    assert.equal(record.kind, 'streamer');
    assert.equal(record.engine, 'srs');
    assert.equal(record.stackVersion, 'v3.4.0');
    assert.equal(record.status, 'RUNNING');
    assert.equal(record.observedAt, OBSERVED.toISOString());
  });

  it('says it was observed when the caller read the row, not after the slower readings', async () => {
    const readAt = new Date('2026-09-28T09:59:58.000Z');
    const result = await builder().build(stage(), readAt);
    assert.ok(result.ok);
    assert.equal(result.record.observedAt, readAt.toISOString());
  });

  it('says OME for a deployment that runs it, with its SRT port', async () => {
    const { record } = await built(
      { env: baseEnv({ OME_SRT_PORT: '10022' }) },
      stage({ components: ['ome', 'stream-uploader', 'bee-uploader'] }),
    );
    assert.equal(record.engine, 'ome');
    assert.equal(record.ingest.srtPort, 10022);
  });

  it('carries the ingest encoders dial: the address, the slot’s ports, RTMP offered on SRS and the passphrase', async () => {
    const { record } = await built();
    assert.deepEqual(record.ingest, {
      host: '192.0.2.10',
      srtPort: 10012,
      rtmpPort: 10013,
      rtmpPublic: true,
      srtPassphrase: PASSPHRASE,
    });
  });

  it('offers no RTMP on an OME stage, because OvenMediaEngine takes SRT alone', async () => {
    const { record } = await built(
      { env: baseEnv({ OME_SRT_PORT: '10022' }) },
      stage({ components: ['ome', 'stream-uploader', 'bee-uploader'] }),
    );
    assert.equal(record.ingest.rtmpPublic, false);
  });

  it('takes the deployment’s own ingest address, and the manager’s public one for a local deployment', async () => {
    assert.equal(
      (await built({}, stage({ ingest_host: 'ingest.example.org' }))).record.ingest.host,
      'ingest.example.org',
    );
    assert.equal((await built({}, stage({ network_host: 'localhost' }))).record.ingest.host, 'manager.example.org');
  });

  it('carries no passphrase where the next deploy gives none', async () => {
    const { record } = await built({ env: baseEnv({ SRT_PASSPHRASE: '' }) });
    assert.equal(record.ingest.srtPassphrase, null);
  });

  it('carries the uploader’s state and reasons, and null when it could not be read', async () => {
    const waiting = await built({
      uploader: { state: 'waiting_for_node', reasons: ['node_unavailable'], node: { url: NODE_URL, attempts: 3 } },
    });
    assert.deepEqual(waiting.record.uploader, { state: 'waiting_for_node', reasons: ['node_unavailable'] });
    assert.equal((await built({ uploader: 'throws' })).record.uploader, null);
  });

  it('carries the readiness in the admin’s words', async () => {
    const ready = await built({
      stamps: { [BATCH]: liveStamp(BATCH) },
      chequebooks: { 'stage-one': summaryOf(PLUR_PER_BZZ) },
    });
    assert.deepEqual(ready.record.readiness, { tone: 'ready', reasons: [] });

    const stopped = await built({}, stage({ status: 'STOPPED' }));
    assert.equal(stopped.record.readiness.tone, 'blocked');
    assert.ok(stopped.record.readiness.reasons.length > 0);
  });
});

describe('the owner', () => {
  it('is the address of the stream key the next deploy gives, in lower case', async () => {
    assert.equal((await built()).record.owner, OWNER);
  });

  it('leaves no record when the next deploy gives no key, and says why without a key in it', async () => {
    const result = await builder({ env: baseEnv({ STREAM_KEY: '' }) }).build(stage());
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.problem, /no stream key/);
  });

  it('never carries the key itself', async () => {
    const { record } = await built();
    assert.doesNotMatch(JSON.stringify(record), new RegExp(STREAM_KEY.slice(2)));
  });
});

describe('the rungs', () => {
  it('is one rung for a stage with its own node, read there', async () => {
    const { record } = await built({
      stamps: { [BATCH]: liveStamp(BATCH, 500_000) },
      chequebooks: { 'stage-one': summaryOf(3n * PLUR_PER_BZZ + PLUR_PER_BZZ / 4n) },
    });
    assert.deepEqual(record.rungs, [
      {
        name: SINGLE_RUNG_NAME,
        stamp: { batchId: BATCH, state: 'active', ttlSeconds: 500_000, fillRatio: 0.25, immutable: true },
        chequebook: { health: 'ok', availableBzz: '3.25' },
      },
    ]);
  });

  it('reads each rung of a pool on the node that stamps with its batch, lowest first', async () => {
    const node = (rung: string) =>
      makeProfile({
        name: `pool-${rung}`,
        kind: 'custom',
        components: ['bee-uploader'],
        stamp_id: `0x${RUNG_BATCHES[rung]}`,
        host: '192.0.2.40',
      });
    const pooled = stage({
      kind: 'abr-uploader',
      components: ['srs', 'stream-uploader'],
      stamp_id: null,
      bee_publishers: POOL,
      containers: [{ service: 'srs', ports: {}, buildId: null, buildCommit: null }],
    });
    const { record } = await built(
      {
        profiles: [node('360p'), node('480p'), node('1080p')],
        stamps: { [RUNG_BATCHES['360p']!]: liveStamp(RUNG_BATCHES['360p']!) },
        chequebooks: { 'pool-360p': summaryOf(0n) },
      },
      pooled,
    );
    assert.deepEqual(
      record.rungs.map((rung) => rung.name),
      ['360p', '480p', '720p', '1080p'],
    );
    assert.equal(record.rungs[0]!.stamp?.state, 'active');
    assert.deepEqual(record.rungs[0]!.chequebook, { health: 'empty', availableBzz: '0' });
    // A node that did not answer is unknown, and a rung no node here stamps for has no reading at all.
    assert.equal(record.rungs[1]!.stamp?.state, 'unknown');
    assert.equal(record.rungs[1]!.chequebook, null);
    assert.deepEqual(record.rungs[2], { name: '720p', stamp: null, chequebook: null });
  });

  it('never carries a node address', async () => {
    const { record } = await built({
      stamps: { [BATCH]: liveStamp(BATCH) },
      chequebooks: { 'stage-one': summaryOf(PLUR_PER_BZZ) },
      uploader: { state: 'waiting_for_node', reasons: [], node: { url: NODE_URL, attempts: 1 } },
    });
    const text = JSON.stringify(record);
    assert.doesNotMatch(text, /192\.0\.2\.30|192\.0\.2\.40|10015/);
    assert.doesNotMatch(text, /0x[c]{40}/, 'no chequebook address');
  });
});

describe('the admin token', () => {
  const sha = (token: string) => createHash('sha256').update(token).digest('hex');

  it('is shared for a token the deployment stores or its version sets, whatever it is', async () => {
    assert.deepEqual((await built()).record.adminToken, { sha256: sha(SHARED_TOKEN), kind: 'shared' });
    // An old copy of the registrar token, after the link's token changed: still shared, never a stage's own.
    const oldCopy = await built({ env: baseEnv({ ADMIN_API_TOKEN: OWN_TOKEN }) });
    assert.deepEqual(oldCopy.record.adminToken, { sha256: sha(OWN_TOKEN), kind: 'shared' });
  });

  it('is own only for the token the manager generated for the deployment', async () => {
    const own = await built({ env: baseEnv({ ADMIN_API_TOKEN: OWN_TOKEN }), ownAdminToken: true });
    assert.deepEqual(own.record.adminToken, { sha256: sha(OWN_TOKEN), kind: 'own' });
  });

  it('is null when the uploader is given none', async () => {
    assert.equal((await built({ env: baseEnv({ ADMIN_API_TOKEN: '' }) })).record.adminToken, null);
  });
});

describe('what a record never carries', () => {
  it('holds no key, no token, no RPC endpoint and no node address, and passes the contract', async () => {
    const result = await built({
      stamps: { [BATCH]: liveStamp(BATCH) },
      chequebooks: { 'stage-one': summaryOf(PLUR_PER_BZZ) },
      uploader: { state: 'waiting_for_node', reasons: ['node_unavailable'], node: { url: NODE_URL, attempts: 2 } },
    });
    const text = JSON.stringify(result.record);
    for (const secret of [
      STREAM_KEY,
      STREAM_KEY.slice(2),
      SHARED_TOKEN,
      OWN_TOKEN,
      RPC_ENDPOINT,
      'synthetic-rpc-key',
      NODE_URL,
    ]) {
      assert.ok(!text.includes(secret), `the record carries ${secret.slice(0, 12)}…`);
    }
    assert.ok(stageRecordSchema.safeParse(result.record).success);
    assert.equal(result.adminApiUrl, 'https://admin.example.org');
  });

  it('keeps the passphrase, which the admin shows on the OBS panel, and no other value of the env but the slot’s ports', async () => {
    // Two of the stack's own secrets, which the builder never reads, beside the ones it does.
    const env = baseEnv({
      API_AUTH_TOKEN: 'synthetic-api-auth-token-0123456789abcdef',
      PUBLISH_KEY_SECRET: 'synthetic-publish-key-secret-0123456789ab',
    });
    const { record } = await built({ env });
    const holding = (value: string) =>
      leavesOf(record)
        .filter(([, leaf]) => leaf.includes(value))
        .map(([path]) => path);
    assert.deepEqual(holding(PASSPHRASE), ['ingest.srtPassphrase']);
    assert.deepEqual(holding('10012'), ['ingest.srtPort']);
    assert.deepEqual(holding('10013'), ['ingest.rtmpPort']);
    for (const [key, value] of Object.entries(env)) {
      if (key === 'SRT_PASSPHRASE' || key === 'SRS_SRT_PORT' || key === 'SRS_RTMP_PORT') continue;
      assert.deepEqual(holding(value), [], `the record carries ${key}`);
    }
    const keys = new Set(Object.keys(record));
    assert.deepEqual([...keys].sort(), [
      'adminToken',
      'engine',
      'ingest',
      'kind',
      'managerId',
      'name',
      'observedAt',
      'owner',
      'readiness',
      'rungs',
      'schemaVersion',
      'stackVersion',
      'stageId',
      'status',
      'uploader',
    ]);
  });
});

describe('when there is no record to build', () => {
  it('never gives a loopback address: no own address, a local deployment and no PUBLIC_HOST is no record', async () => {
    for (const [profile, publicHost] of [
      [stage({ network_host: 'localhost' }), ''],
      [stage({ network_host: '127.0.0.1' }), ''],
      [stage({ network_host: '' }), 'localhost'],
      [stage({ network_host: 'native' }), '127.0.0.1'],
      [stage({ ingest_host: 'localhost' }), 'manager.example.org'],
      [stage({ network_host: '[::1]' }), 'manager.example.org'],
    ] as const) {
      const result = await builder({}, publicHost).build(profile);
      assert.equal(result.ok, false, `${profile.ingest_host ?? profile.network_host} / ${publicHost}`);
      assert.equal(result.ok ? '' : result.problem, NO_PUBLIC_INGEST_HOST);
    }
    assert.match(NO_PUBLIC_INGEST_HOST, /set the deployment's public ingest address or PUBLIC_HOST/);
  });

  it('is no stage for a kind that runs no uploader', async () => {
    const result = await builder().build(stage({ kind: 'viewer' }));
    assert.equal(result.ok, false);
  });

  it('says why when the next deploy cannot be worked out', async () => {
    const result = await builder({ nextEnvThrows: true }).build(stage());
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.problem, /could not be worked out: The version has no build yet/);
  });

  it('refuses a record the contract would refuse, by field name alone', async () => {
    const result = await builder().build(stage({ ingest_host: 'bad host:1', instance_id: STAGE_ID }));
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.problem, /ingest\.host/);
    assert.doesNotMatch(result.ok ? '' : result.problem, /bad host/);
  });
});
