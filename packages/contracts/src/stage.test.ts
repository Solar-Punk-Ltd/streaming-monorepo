import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sameFeedOwner } from './adminAnswers.js';
import {
  ADMIN_TOKEN_KINDS,
  CATALOGUE_STAMP_PATH,
  catalogueStampClearAnswerSchema,
  catalogueStampClearRequestSchema,
  catalogueStampRecordSchema,
  isOlderStageRecord,
  STAGE_CHEQUEBOOK_HEALTHS,
  STAGE_ENGINES,
  STAGE_KINDS,
  STAGE_READINESS_TONES,
  STAGE_RECORD_SCHEMA_VERSION,
  STAGE_SELF_PATH,
  STAGE_STAMP_STATES,
  STAMP_EXPIRY_WARNING_SECONDS,
  stageRecordPath,
  stageRecordSchema,
  stageRetireAnswerSchema,
  stageRetireRequestSchema,
  stageRungSchema,
  stageSelfAnswerSchema,
  stageStampSchema,
  stageStoreAnswerSchema,
} from './stage.js';

const STAGE_ID = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const MANAGER_ID = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const OWNER = '0x1111111111111111111111111111111111111111';
const BATCH = 'ab'.repeat(32);

const stamp = () => ({ batchId: BATCH, state: 'active', ttlSeconds: 86_400, fillRatio: 0.25, immutable: true });

const record = () => ({
  schemaVersion: 1,
  stageId: STAGE_ID,
  managerId: MANAGER_ID,
  name: 'brand-a main stage',
  kind: 'abr-uploader',
  engine: 'srs',
  stackVersion: 'v3.4.0',
  status: 'running',
  observedAt: '2026-09-28T10:00:00.000Z',
  ingest: { host: 'ingest.example.org', srtPort: 10080, rtmpPort: 1935, rtmpPublic: false, srtPassphrase: null },
  owner: OWNER,
  rungs: [
    { name: '1080p', stamp: stamp(), chequebook: { health: 'ok', availableBzz: '1.25' } },
    { name: '720p', stamp: null, chequebook: null },
  ],
  uploader: { state: 'ok', reasons: [] },
  readiness: { tone: 'ready', reasons: [] },
  adminToken: { sha256: 'cd'.repeat(32), kind: 'own' },
});

const catalogueStamp = () => ({
  schemaVersion: 1,
  managerId: MANAGER_ID,
  nodeName: 'catalogue',
  beeApiUrl: 'http://bee-catalogue.example.org:1633',
  batchId: BATCH,
  immutable: true,
  depth: 22,
  state: 'active',
  ttlSeconds: 2_592_000,
  fillRatio: 0.01,
  designatedAt: '2026-09-20T08:00:00Z',
  observedAt: '2026-09-28T10:00:00Z',
});

const refuses = (value: unknown) => assert.equal(stageRecordSchema.safeParse(value).success, false);

describe('the stage record words', () => {
  it('pins the version, the kinds, the engines and the readiness tones', () => {
    assert.equal(STAGE_RECORD_SCHEMA_VERSION, 1);
    assert.deepEqual(STAGE_KINDS, ['abr-uploader', 'streamer']);
    assert.deepEqual(STAGE_ENGINES, ['srs', 'ome']);
    assert.deepEqual(STAGE_READINESS_TONES, ['ready', 'warning', 'blocked', 'unknown']);
    assert.deepEqual(ADMIN_TOKEN_KINDS, ['own', 'shared']);
  });

  it("names a batch's state and a chequebook's health in the manager's words", () => {
    assert.deepEqual(STAGE_STAMP_STATES, ['none', 'unknown', 'active', 'pending', 'full', 'expired', 'gone']);
    assert.deepEqual(STAGE_CHEQUEBOOK_HEALTHS, ['unknown', 'ok', 'low', 'empty']);
  });

  it('warns about a batch with two days left', () => {
    assert.equal(STAMP_EXPIRY_WARNING_SECONDS, 172_800);
  });
});

describe('a stage record', () => {
  it('reads a whole record as it was sent', () => {
    assert.deepEqual(stageRecordSchema.parse(record()), record());
  });

  it('takes a streamer on OME with no readings', () => {
    const parsed = stageRecordSchema.parse({
      ...record(),
      kind: 'streamer',
      engine: 'ome',
      stackVersion: null,
      rungs: [],
      uploader: null,
      readiness: { tone: 'unknown', reasons: ['The manager could not read the uploader.'] },
      adminToken: null,
    });
    assert.equal(parsed.kind, 'streamer');
    assert.equal(parsed.uploader, null);
    assert.equal(parsed.adminToken, null);
  });

  it('keeps the ids, the owner, the batch and the token hash in lower case', () => {
    const upper = record();
    upper.stageId = STAGE_ID.toUpperCase();
    upper.managerId = MANAGER_ID.toUpperCase();
    upper.owner = `0x${'A'.repeat(40)}`;
    upper.rungs[0]!.stamp!.batchId = BATCH.toUpperCase();
    upper.adminToken.sha256 = 'CD'.repeat(32);
    const parsed = stageRecordSchema.parse(upper);
    assert.equal(parsed.stageId, STAGE_ID);
    assert.equal(parsed.managerId, MANAGER_ID);
    assert.equal(parsed.owner, `0x${'a'.repeat(40)}`);
    assert.equal(parsed.rungs[0]!.stamp!.batchId, BATCH);
    assert.equal(parsed.adminToken!.sha256, 'cd'.repeat(32));
  });

  it('keeps an owner that sameFeedOwner takes for the one sent', () => {
    const sent = `0x${'Ab'.repeat(20)}`;
    const parsed = stageRecordSchema.parse({ ...record(), owner: sent });
    assert.equal(sameFeedOwner(parsed.owner, sent), true);
  });

  it('reads an empty passphrase as none and keeps one that is set', () => {
    const empty = record();
    (empty.ingest as { srtPassphrase: string | null }).srtPassphrase = '';
    assert.equal(stageRecordSchema.parse(empty).ingest.srtPassphrase, null);
    const set = record();
    (set.ingest as { srtPassphrase: string | null }).srtPassphrase = 'a-passphrase-of-some-length';
    assert.equal(stageRecordSchema.parse(set).ingest.srtPassphrase, 'a-passphrase-of-some-length');
  });

  it('takes an ingest host that is a name, an IPv4 address or a bracketed IPv6 one, kept in lower case', () => {
    for (const host of ['ingest.example.org', '192.0.2.10', '[2001:db8::1]', 'localhost']) {
      assert.equal(stageRecordSchema.parse({ ...record(), ingest: { ...record().ingest, host } }).ingest.host, host);
    }
    const parsed = stageRecordSchema.parse({ ...record(), ingest: { ...record().ingest, host: 'Ingest.Example.ORG' } });
    assert.equal(parsed.ingest.host, 'ingest.example.org');
  });

  it('refuses an ingest host with a scheme, a port, a path, a credential or nothing in it', () => {
    for (const host of [
      '',
      'srt://ingest.example.org',
      'ingest.example.org:10080',
      'ingest.example.org/live',
      'alice@ingest.example.org',
      'ingest example.org',
      '2001:db8::1',
      'ingest.example.org?x=1',
    ]) {
      refuses({ ...record(), ingest: { ...record().ingest, host } });
    }
  });

  it('refuses a port that is not a whole number from 1 to 65535', () => {
    for (const bad of [0, 65536, 1935.5, '1935', -1]) {
      refuses({ ...record(), ingest: { ...record().ingest, srtPort: bad } });
      refuses({ ...record(), ingest: { ...record().ingest, rtmpPort: bad } });
    }
    const edges = stageRecordSchema.parse({ ...record(), ingest: { ...record().ingest, srtPort: 1, rtmpPort: 65535 } });
    assert.equal(edges.ingest.srtPort, 1);
    assert.equal(edges.ingest.rtmpPort, 65535);
  });

  it('refuses another schema version', () => {
    refuses({ ...record(), schemaVersion: 2 });
    refuses({ ...record(), schemaVersion: '1' });
  });

  it('refuses ids that are not UUIDs', () => {
    refuses({ ...record(), stageId: 'stage-1' });
    refuses({ ...record(), managerId: `${MANAGER_ID}0` });
  });

  it('refuses a kind or an engine it does not know', () => {
    refuses({ ...record(), kind: 'bee-only' });
    refuses({ ...record(), engine: 'nginx' });
  });

  it('refuses an empty name or status and a stack version that is not text or null', () => {
    refuses({ ...record(), name: '' });
    refuses({ ...record(), status: '' });
    refuses({ ...record(), stackVersion: 3 });
  });

  it('refuses an observation time that is not an ISO moment with its offset', () => {
    for (const observedAt of ['2026-09-28', '2026-09-28T10:00:00', 'yesterday', 1_790_000_000_000]) {
      refuses({ ...record(), observedAt });
    }
    assert.equal(
      stageRecordSchema.parse({ ...record(), observedAt: '2026-09-28T12:00:00+02:00' }).observedAt,
      '2026-09-28T12:00:00+02:00',
    );
  });

  it('refuses an owner that is not 0x and 40 hex digits', () => {
    for (const owner of ['1111111111111111111111111111111111111111', `0x${'1'.repeat(39)}`, `0x${'g'.repeat(40)}`]) {
      refuses({ ...record(), owner });
    }
  });

  it('refuses a readiness tone or a token kind it does not know', () => {
    refuses({ ...record(), readiness: { tone: 'green', reasons: [] } });
    refuses({ ...record(), readiness: { tone: 'ready' } });
    refuses({ ...record(), adminToken: { sha256: 'cd'.repeat(32), kind: 'borrowed' } });
    refuses({ ...record(), adminToken: { sha256: 'cd'.repeat(31), kind: 'own' } });
  });

  it('refuses an uploader reading without a state or its reasons', () => {
    refuses({ ...record(), uploader: { state: '', reasons: [] } });
    refuses({ ...record(), uploader: { state: 'ok' } });
  });

  it('refuses a record with a field missing', () => {
    for (const field of Object.keys(record())) {
      const partial: Record<string, unknown> = record();
      delete partial[field];
      refuses(partial);
    }
  });

  it('drops what a newer sender adds, so no key, token or node address is ever carried', () => {
    const sent = {
      ...record(),
      streamKey: `0x${'a'.repeat(64)}`,
      privateKey: `0x${'a'.repeat(64)}`,
      walletKey: `0x${'b'.repeat(64)}`,
      rpcUrl: 'https://rpc.example.org',
      ingest: { ...record().ingest, token: 'a-token-value-of-some-length-000000' },
      rungs: [
        { ...record().rungs[0], nodeUrl: 'http://bee-1.example.org:1633', nodeAddress: OWNER },
        record().rungs[1],
      ],
      uploader: { state: 'waiting_for_node', reasons: [], node: { url: 'http://bee-1.example.org:1633', attempts: 3 } },
      adminToken: { ...record().adminToken, token: 'a-token-value-of-some-length-000000' },
    };
    const parsed = stageRecordSchema.parse(sent);
    assert.deepEqual(parsed, { ...record(), uploader: { state: 'waiting_for_node', reasons: [] } });
    const text = JSON.stringify(parsed);
    for (const leaked of ['a'.repeat(64), 'b'.repeat(64), 'rpc.example.org', 'a-token-value', 'bee-1.example.org']) {
      assert.equal(text.includes(leaked), false, leaked);
    }
  });
});

describe("a rung's stamp and chequebook", () => {
  it('reads a stamp whose node said nothing about its life or its fill', () => {
    const parsed = stageStampSchema.parse({
      ...stamp(),
      state: 'unknown',
      ttlSeconds: null,
      fillRatio: null,
      immutable: null,
    });
    assert.equal(parsed.ttlSeconds, null);
    assert.equal(parsed.immutable, null);
  });

  it('keeps a negative TTL, which is Bee saying it cannot tell', () => {
    assert.equal(stageStampSchema.parse({ ...stamp(), ttlSeconds: -1 }).ttlSeconds, -1);
  });

  it('refuses a batch id with 0x or of another length', () => {
    for (const id of [`0x${BATCH}`, BATCH.slice(2), `${BATCH}00`, 'zz'.repeat(32)]) {
      assert.equal(stageStampSchema.safeParse({ ...stamp(), batchId: id }).success, false, id);
    }
  });

  it('refuses a state it does not know and readings that are not numbers', () => {
    assert.equal(stageStampSchema.safeParse({ ...stamp(), state: 'usable' }).success, false);
    assert.equal(stageStampSchema.safeParse({ ...stamp(), ttlSeconds: '60' }).success, false);
    assert.equal(stageStampSchema.safeParse({ ...stamp(), fillRatio: Number.NaN }).success, false);
  });

  it('takes a chequebook amount as decimal text or null, and no other', () => {
    const rung = (availableBzz: unknown) => ({
      name: '480p',
      stamp: null,
      chequebook: { health: 'low', availableBzz },
    });
    for (const amount of ['0', '12', '0.0000000000000001', null]) {
      assert.equal(stageRungSchema.safeParse(rung(amount)).success, true, String(amount));
    }
    for (const amount of ['', '1.', '.5', '-1', '1e3', 1.25]) {
      assert.equal(stageRungSchema.safeParse(rung(amount)).success, false, String(amount));
    }
    assert.equal(
      stageRungSchema.safeParse({ name: '480p', stamp: null, chequebook: { health: 'drained', availableBzz: null } })
        .success,
      false,
    );
  });

  it('refuses a rung without a name', () => {
    assert.equal(stageRungSchema.safeParse({ name: '', stamp: null, chequebook: null }).success, false);
  });
});

describe('a catalogue stamp record', () => {
  it('reads a whole record as it was sent', () => {
    assert.deepEqual(catalogueStampRecordSchema.parse(catalogueStamp()), catalogueStamp());
  });

  it('keeps the manager id and the batch in lower case', () => {
    const parsed = catalogueStampRecordSchema.parse({
      ...catalogueStamp(),
      managerId: MANAGER_ID.toUpperCase(),
      batchId: BATCH.toUpperCase(),
    });
    assert.equal(parsed.managerId, MANAGER_ID);
    assert.equal(parsed.batchId, BATCH);
  });

  it('takes an https Bee address with a path', () => {
    const beeApiUrl = 'https://bee.example.org/catalogue';
    assert.equal(catalogueStampRecordSchema.parse({ ...catalogueStamp(), beeApiUrl }).beeApiUrl, beeApiUrl);
  });

  it('refuses a Bee address of another scheme, with a credential or a fragment, or none at all', () => {
    for (const beeApiUrl of [
      'ftp://bee.example.org',
      'bee.example.org:1633',
      'http://alice:secret@bee.example.org:1633',
      'http://alice@bee.example.org:1633',
      'http://bee.example.org:1633/#top',
      'http://bee.example.org:1633#',
      '',
    ]) {
      assert.equal(catalogueStampRecordSchema.safeParse({ ...catalogueStamp(), beeApiUrl }).success, false, beeApiUrl);
    }
  });

  it('takes a depth from 17 to 64 and no other', () => {
    for (const depth of [17, 64]) {
      assert.equal(catalogueStampRecordSchema.parse({ ...catalogueStamp(), depth }).depth, depth);
    }
    for (const depth of [16, 65, 20.5, '22']) {
      assert.equal(catalogueStampRecordSchema.safeParse({ ...catalogueStamp(), depth }).success, false, String(depth));
    }
  });

  it('refuses a mutability that is not said, another version and moments that are not ISO', () => {
    const refusesStamp = (value: unknown) => assert.equal(catalogueStampRecordSchema.safeParse(value).success, false);
    refusesStamp({ ...catalogueStamp(), immutable: null });
    refusesStamp({ ...catalogueStamp(), schemaVersion: 2 });
    refusesStamp({ ...catalogueStamp(), designatedAt: '2026-09-20' });
    refusesStamp({ ...catalogueStamp(), observedAt: 'now' });
    refusesStamp({ ...catalogueStamp(), nodeName: '' });
    refusesStamp({ ...catalogueStamp(), state: 'fine' });
  });

  it('drops what a newer sender adds, a wallet key and a node password among them', () => {
    const parsed = catalogueStampRecordSchema.parse({
      ...catalogueStamp(),
      walletKey: `0x${'a'.repeat(64)}`,
      nodePassword: 'secret',
    });
    assert.deepEqual(parsed, catalogueStamp());
  });
});

describe("the admin's answers", () => {
  it('reads whether a record was stored or a stage retired', () => {
    assert.deepEqual(stageStoreAnswerSchema.parse({ stored: false, reason: 'newer' }), { stored: false });
    assert.deepEqual(stageRetireAnswerSchema.parse({ retired: true }), { retired: true });
    assert.equal(stageStoreAnswerSchema.safeParse({ stored: 'yes' }).success, false);
    assert.equal(stageRetireAnswerSchema.safeParse({}).success, false);
  });

  it('reads whether the catalogue stamp was cleared', () => {
    assert.deepEqual(catalogueStampClearAnswerSchema.parse({ cleared: true, extra: 1 }), { cleared: true });
    assert.equal(catalogueStampClearAnswerSchema.safeParse({ cleared: 'no' }).success, false);
    assert.equal(catalogueStampClearAnswerSchema.safeParse({}).success, false);
  });
});

describe("the manager's retirements", () => {
  it('carry the moment the manager saw the stage or the designation gone', () => {
    for (const schema of [stageRetireRequestSchema, catalogueStampClearRequestSchema]) {
      assert.deepEqual(schema.parse({ observedAt: '2026-09-28T10:00:00.000Z', reason: 'deleted' }), {
        observedAt: '2026-09-28T10:00:00.000Z',
      });
      assert.deepEqual(schema.parse({ observedAt: '2026-09-28T12:00:00+02:00' }), {
        observedAt: '2026-09-28T12:00:00+02:00',
      });
    }
  });

  it('refuse a retirement without its moment, or with one that is not ISO with an offset', () => {
    for (const schema of [stageRetireRequestSchema, catalogueStampClearRequestSchema]) {
      for (const body of [{}, { observedAt: null }, { observedAt: 'now' }, { observedAt: '2026-09-28T10:00:00' }]) {
        assert.equal(schema.safeParse(body).success, false, JSON.stringify(body));
      }
    }
  });

  it("reads the caller's stage and owner, in lower case", () => {
    assert.deepEqual(stageSelfAnswerSchema.parse({ stageId: STAGE_ID.toUpperCase(), owner: OWNER, name: 'x' }), {
      stageId: STAGE_ID,
      owner: OWNER,
    });
    assert.equal(stageSelfAnswerSchema.safeParse({ stageId: STAGE_ID, owner: 'nobody' }).success, false);
    assert.equal(stageSelfAnswerSchema.safeParse({ stageId: 'self', owner: OWNER }).success, false);
  });
});

describe('the stage paths', () => {
  it("puts a stage's id, in lower case, under the internal stages path", () => {
    assert.equal(stageRecordPath(STAGE_ID), `/api/internal/stages/${STAGE_ID}`);
    assert.equal(stageRecordPath(STAGE_ID.toUpperCase()), `/api/internal/stages/${STAGE_ID}`);
  });

  it('refuses an id that is not a UUID, so none writes a path of its own', () => {
    for (const id of ['self', '', '../streams', `${STAGE_ID}/x`, `${STAGE_ID}?x=1`]) {
      assert.throws(() => stageRecordPath(id), /UUID/, id);
    }
  });

  it('names the catalogue stamp and the self paths', () => {
    assert.equal(CATALOGUE_STAMP_PATH, '/api/internal/catalogue-stamp');
    assert.equal(STAGE_SELF_PATH, '/api/internal/stages/self');
  });
});

describe('which of two records is older', () => {
  const at = (observedAt: string) => ({ observedAt });

  it('says a record read earlier is older', () => {
    assert.equal(isOlderStageRecord(at('2026-09-28T09:59:59.999Z'), at('2026-09-28T10:00:00.000Z')), true);
    assert.equal(isOlderStageRecord(at('2026-09-28T10:00:01Z'), at('2026-09-28T10:00:00Z')), false);
  });

  it('says two records read at one moment are not older than each other', () => {
    assert.equal(isOlderStageRecord(at('2026-09-28T10:00:00Z'), at('2026-09-28T10:00:00.000Z')), false);
  });

  it('compares the moments, not the text, across offsets', () => {
    assert.equal(isOlderStageRecord(at('2026-09-28T11:30:00+02:00'), at('2026-09-28T10:00:00Z')), true);
    assert.equal(isOlderStageRecord(at('2026-09-28T10:00:00Z'), at('2026-09-28T11:30:00+02:00')), false);
  });

  it('works on parsed records', () => {
    const stored = stageRecordSchema.parse(record());
    const incoming = stageRecordSchema.parse({ ...record(), observedAt: '2026-09-28T09:00:00Z' });
    assert.equal(isOlderStageRecord(incoming, stored), true);
    assert.equal(isOlderStageRecord(stored, incoming), false);
  });
});
