/**
 * The catalogue publisher: when it pushes the brand's catalogue stamp record, what the record says, when it clears
 * it, and that one call never overtakes another.
 *
 * Unit test on a fake clock and a fake admin client, no database, no network. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type ArchiveBatchDesignation,
  type CataloguePushOutcome,
  type StampHealth,
  stampHealthFrom,
} from '@streaming-infra-manager/common';
import { CATALOGUE_ARCHIVE_BATCHES_MAX, catalogueStampRecordSchema } from '@streaming-monorepo/contracts';

import { EventBus } from '../../src/domain/EventBus.js';
import { Logger } from '../../src/domain/Logger.js';
import {
  CATALOGUE_CHECK_MS,
  CATALOGUE_TTL_DRIFT_SECONDS,
  CataloguePublisher,
  publishedBeeApiUrl,
} from '../../src/domain/stages/CataloguePublisher.js';
import type { CatalogueRequest } from '../../src/domain/stages/catalogueRequest.js';
import type { StageClock } from '../../src/domain/stages/StagePublisher.js';
import type { Profile } from '../../src/types/index.js';
import { InMemoryCatalogueDesignation } from '../support/InMemoryCatalogueDesignation.js';
import { makeProfile } from '../support/profileFixtures.js';

const LINK_URL = 'https://admin.example.org';
const LINK_TOKEN = 'synthetic-registrar-token-0123456789abcdef';
const MANAGER_ID = '00000000-0000-4000-8000-000000000099';
const BATCH = 'ab'.repeat(32);
const BEE_API = 'http://192.0.2.30:10025';
const DESIGNATED_AT = new Date('2026-09-28T09:00:00.000Z');

class FakeClock implements StageClock {
  time = Date.parse('2026-09-28T10:00:00.000Z');
  private next = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void; every?: number }>();

  now = () => this.time;
  setTimeout = (fn: () => void, ms: number) => this.add(fn, ms);
  setInterval = (fn: () => void, ms: number) => this.add(fn, ms, ms);
  clearTimeout = (handle: unknown) => void this.timers.delete(handle as number);
  clearInterval = (handle: unknown) => void this.timers.delete(handle as number);

  private add(fn: () => void, ms: number, every?: number): number {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, fn, every });
    return id;
  }

  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.time = timer.at;
      if (timer.every) timer.at += timer.every;
      else this.timers.delete(id);
      timer.fn();
      await settle();
    }
    this.time = end;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

interface Reading {
  health: StampHealth;
  depth: number | null;
}

function readingOf(over: { ttl?: number; utilization?: number; immutable?: boolean } = {}): Reading {
  const stamp = {
    batchID: BATCH,
    usable: true,
    batchTTL: over.ttl ?? 90 * 86_400,
    depth: 20,
    bucketDepth: 16,
    utilization: over.utilization ?? 2,
    immutableFlag: over.immutable ?? true,
    exists: true,
  };
  return { health: stampHealthFrom(BATCH, [stamp]), depth: 20 };
}

interface Setup {
  link?: { url: string | null; token: string | null };
  answer?: (request: CatalogueRequest) => Promise<CataloguePushOutcome> | CataloguePushOutcome;
  designated?: boolean;
  beeApiUrl?: string;
  /** A Bee API per deployment name, over `beeApiUrl`. */
  beeApiUrls?: Record<string, string>;
  /** The production address, `publishedBeeApiUrl`, in place of the two above. */
  published?: (profile: Profile) => Promise<string>;
  profiles?: Profile[];
  /** The archive batches, which the publisher reads only when a test gives some, an empty list included. */
  archive?: ArchiveBatchDesignation[];
}

async function publisherFor(setup: Setup = {}) {
  const clock = new FakeClock();
  const events = new EventBus();
  const store = new InMemoryCatalogueDesignation();
  if (setup.designated !== false) {
    await store.designate({ profileName: 'catalogue', batchId: BATCH, batchDepth: 20, at: DESIGNATED_AT }, 0, 'op');
  }
  const profiles = setup.profiles ?? [makeProfile({ name: 'catalogue', kind: 'custom', components: ['bee-uploader'] })];
  const link = { ...(setup.link ?? { url: LINK_URL, token: LINK_TOKEN }) };
  const sent: CatalogueRequest[] = [];
  const state: {
    reading: Reading;
    /** A reading per batch, where a test sets one; `reading` for any other. */
    byBatch: Map<string, Reading>;
    readingDelayMs: number;
    /** While set, every node reading waits for it. */
    readingGate: Promise<void> | null;
    readings: number;
    /** The archive batches the list answers, or an error it rejects with. */
    archive: ArchiveBatchDesignation[] | Error;
    /** Each depth a reading had the archive batches keep. */
    depthsRecorded: Array<[string, number]>;
  } = {
    reading: readingOf(),
    byBatch: new Map(),
    readingDelayMs: 0,
    readingGate: null,
    readings: 0,
    archive: (setup.archive ?? []).map((row) => ({ ...row })),
    depthsRecorded: [],
  };
  const publisher = new CataloguePublisher({
    designation: store,
    archiveBatches: setup.archive
      ? {
          list: async () => {
            if (state.archive instanceof Error) throw state.archive;
            return state.archive.map((row) => ({ ...row }));
          },
          recordDepth: async (batchId: string, depth: number) => {
            if (state.archive instanceof Error) return;
            const row = state.archive.find((entry) => entry.batchId === batchId);
            if (row) row.depth = depth;
            state.depthsRecorded.push([batchId, depth]);
          },
        }
      : undefined,
    profiles: { findByName: async (name) => profiles.find((profile) => profile.name === name) ?? null },
    reading: async (_profile, batchId) => {
      if (state.readingGate) await state.readingGate;
      // A slow node: the record still says the moment its row was read.
      clock.time += state.readingDelayMs;
      state.readings += 1;
      return state.byBatch.get(batchId) ?? state.reading;
    },
    beeApiUrl: setup.published ?? (async (profile) => setup.beeApiUrls?.[profile.name] ?? setup.beeApiUrl ?? BEE_API),
    link: { storedLink: async () => ({ ...link }) },
    events,
    managerId: MANAGER_ID,
    clock,
    send: async (request) => {
      sent.push(request);
      return setup.answer ? setup.answer(request) : request.kind === 'store' ? 'stored' : 'cleared';
    },
  });
  return { publisher, clock, events, store, sent, state, link, profiles };
}

const stores = (sent: CatalogueRequest[]) => sent.filter((request) => request.kind === 'store');

describe('the catalogue stamp record', () => {
  it('is pushed at start to the link with its token, validated, and names the node as the control host reaches it', async () => {
    const t = await publisherFor();
    t.state.readingDelayMs = 2_500;
    const startedAt = t.clock.now();
    t.publisher.start();
    await settle();

    assert.equal(t.sent.length, 1);
    const request = t.sent[0]!;
    assert.equal(request.kind, 'store');
    assert.equal(request.baseUrl, LINK_URL);
    assert.equal(request.token, LINK_TOKEN);
    assert.ok(request.kind === 'store');
    assert.deepEqual(catalogueStampRecordSchema.parse(request.record), request.record);
    assert.deepEqual(request.record, {
      schemaVersion: 1,
      managerId: MANAGER_ID,
      nodeName: 'catalogue',
      beeApiUrl: BEE_API,
      batchId: BATCH,
      immutable: true,
      depth: 20,
      state: 'active',
      ttlSeconds: 90 * 86_400,
      fillRatio: 2 / 16,
      designatedAt: DESIGNATED_AT.toISOString(),
      // The moment the row was read, before the node took its two and a half seconds.
      observedAt: new Date(startedAt).toISOString(),
      previous: null,
    });
    assert.equal(t.publisher.status().lastPush?.outcome, 'stored');
    assert.equal(t.publisher.status().reading?.batchId, BATCH);
    t.publisher.stop();
  });

  it('is pushed every 30 seconds, and not on a check that finds nothing new', async () => {
    const t = await publisherFor();
    t.publisher.start();
    await settle();
    await t.clock.advance(CATALOGUE_CHECK_MS);
    await t.clock.advance(CATALOGUE_CHECK_MS);
    assert.equal(stores(t.sent).length, 1, 'two checks with the same readings push nothing');
    await t.clock.advance(CATALOGUE_CHECK_MS);
    assert.equal(stores(t.sent).length, 2, 'the third check is 30 seconds on');
    t.publisher.stop();
  });

  it('is pushed at the next check once the readings change', async () => {
    const t = await publisherFor();
    t.publisher.start();
    await settle();
    t.state.reading = readingOf({ utilization: 9 });
    await t.clock.advance(CATALOGUE_CHECK_MS);
    const sent = stores(t.sent);
    assert.equal(sent.length, 2);
    assert.ok(sent[1]!.kind === 'store');
    assert.equal(sent[1]!.record.fillRatio, 9 / 16);
    t.publisher.stop();
  });

  it('counts a top-up’s jump in life as a change, and the clock’s own wear on it as none', async () => {
    const t = await publisherFor();
    t.publisher.start();
    await settle();
    t.state.reading = readingOf({ ttl: 90 * 86_400 - 10 });
    await t.clock.advance(CATALOGUE_CHECK_MS);
    assert.equal(stores(t.sent).length, 1, 'ten seconds of wear is no change');
    t.state.reading = readingOf({ ttl: 120 * 86_400 });
    await t.clock.advance(CATALOGUE_CHECK_MS);
    assert.equal(stores(t.sent).length, 2, `more than ${CATALOGUE_TTL_DRIFT_SECONDS} s off the clock is a change`);
    t.publisher.stop();
  });

  it('is pushed at once when the designated node changes', async () => {
    const t = await publisherFor();
    t.publisher.start();
    await settle();
    t.events.publish({
      type: 'profile.changed',
      profile: { ...t.profiles[0]!, containers: [], pendingStamp: false, network_host: '192.0.2.30' },
    });
    await settle();
    assert.equal(stores(t.sent).length, 2);
    t.publisher.stop();
  });

  it('is retried at the next check when the admin did not answer', async () => {
    let answers = 0;
    const t = await publisherFor({ answer: () => (answers++ === 0 ? 'unreachable' : 'stored') });
    t.publisher.start();
    await settle();
    assert.equal(t.publisher.status().lastPush?.outcome, 'unreachable');
    await t.clock.advance(CATALOGUE_CHECK_MS);
    assert.equal(stores(t.sent).length, 2);
    assert.equal(t.publisher.status().lastPush?.outcome, 'stored');
    t.publisher.stop();
  });

  it('carries the depth the node reported at designation while the node does not answer', async () => {
    const t = await publisherFor();
    t.state.reading = { health: stampHealthFrom(BATCH, null), depth: null };
    t.publisher.start();
    await settle();
    const request = t.sent[0]!;
    assert.ok(request.kind === 'store');
    assert.equal(request.record.state, 'unknown');
    assert.equal(request.record.depth, 20);
    assert.equal(request.record.immutable, true);
    t.publisher.stop();
  });

  it('is not sent without a link and a token, nor for a designated deployment that is gone', async () => {
    const noLink = await publisherFor({ link: { url: LINK_URL, token: null } });
    await noLink.publisher.pushNow();
    assert.equal(noLink.sent.length, 0);
    assert.equal(noLink.publisher.status().lastPush?.outcome, 'skipped-no-link');

    const gone = await publisherFor({ profiles: [] });
    await gone.publisher.pushNow();
    assert.equal(gone.sent.length, 0);
    assert.equal(gone.publisher.status().lastPush?.outcome, 'skipped-no-node');
  });

  it('is not sent for a node whose Bee API reaches the dialling host alone, with an outcome that says so', async () => {
    for (const url of ['http://127.0.0.1:10025', 'http://localhost:10025', 'http://[::1]:10025']) {
      const t = await publisherFor({ beeApiUrl: url });
      await t.publisher.pushNow();
      assert.equal(t.sent.length, 0, url);
      assert.equal(t.publisher.status().lastPush?.outcome, 'skipped-loopback-address', url);
    }
  });

  it('sends nothing while nothing was ever designated', async () => {
    const t = await publisherFor({ designated: false });
    await t.publisher.pushNow();
    assert.equal(t.sent.length, 0);
    assert.equal(t.publisher.status().lastPush, null);
  });
});

describe('clearing the catalogue stamp', () => {
  it('DELETEs with the moment the designation was taken out, and once answered sends it no more', async () => {
    const t = await publisherFor();
    t.publisher.start();
    await settle();
    const clearedAt = new Date(t.clock.now() - 1_000);
    await t.store.clear(clearedAt, 1, 'op');
    await t.publisher.pushNow();
    const clear = t.sent.at(-1)!;
    assert.deepEqual(clear, {
      kind: 'clear',
      baseUrl: LINK_URL,
      token: LINK_TOKEN,
      observedAt: clearedAt.toISOString(),
    });
    assert.equal(t.publisher.status().lastPush?.kind, 'clear');
    assert.equal(t.publisher.status().reading, null);
    const count = t.sent.length;
    await t.clock.advance(CATALOGUE_CHECK_MS * 4);
    assert.equal(t.sent.length, count, 'an answered clear is not sent again');
    t.publisher.stop();
  });

  it('sends a clear the admin did not answer again, with the same moment', async () => {
    let clears = 0;
    const t = await publisherFor({
      answer: (request) => (request.kind === 'store' ? 'stored' : clears++ === 0 ? 'unreachable' : 'not-cleared'),
    });
    t.publisher.start();
    await settle();
    await t.store.clear(DESIGNATED_AT, 1, 'op');
    await t.publisher.pushNow();
    await t.clock.advance(CATALOGUE_CHECK_MS);
    const sentClears = t.sent.filter((request) => request.kind === 'clear');
    assert.equal(sentClears.length, 2);
    assert.ok(
      sentClears.every((request) => request.kind === 'clear' && request.observedAt === DESIGNATED_AT.toISOString()),
    );
    await t.clock.advance(CATALOGUE_CHECK_MS);
    assert.equal(t.sent.filter((request) => request.kind === 'clear').length, 2);
    t.publisher.stop();
  });

  it('never overtakes the push in flight: the clear goes after it', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const t = await publisherFor({
      answer: async (request) => {
        order.push(`${request.kind} started`);
        if (request.kind === 'store') await held;
        order.push(`${request.kind} ended`);
        return request.kind === 'store' ? 'stored' : 'cleared';
      },
    });
    const push = t.publisher.pushNow();
    await settle();
    await t.store.clear(new Date(t.clock.now()), 1, 'op');
    const clear = t.publisher.pushNow();
    await settle();
    assert.deepEqual(order, ['store started'], 'the clear waits for the push in flight');
    release();
    await push;
    await clear;
    await settle();
    assert.deepEqual(order, ['store started', 'store ended', 'clear started', 'clear ended']);
  });
});

describe('a cleared designation', () => {
  it('stops reading the batch and pushing its readings, and a designation of it again pushes once more', async () => {
    const t = await publisherFor();
    t.publisher.start();
    await settle();
    await t.store.clear(new Date(t.clock.now()), 1, 'op');
    await t.publisher.pushNow();
    const readings = t.state.readings;
    await t.clock.advance(CATALOGUE_CHECK_MS * 4);
    assert.equal(t.state.readings, readings, 'a cleared batch is not read');
    assert.equal(stores(t.sent).length, 1);

    await t.store.designate(
      { profileName: 'catalogue', batchId: BATCH, batchDepth: 20, at: new Date(t.clock.now()) },
      2,
      'op',
    );
    await t.publisher.pushNow();
    assert.equal(stores(t.sent).length, 2);
    assert.equal(t.publisher.status().lastPush?.outcome, 'stored');
    t.publisher.stop();
  });
});

describe('while the catalogue is moving to another batch', () => {
  const NEXT_BATCH = 'cd'.repeat(32);

  const NEXT_BEE_API = 'http://192.0.2.31:10025';

  async function moving(setup: Setup = {}) {
    const t = await publisherFor({
      beeApiUrls: { 'catalogue-two': NEXT_BEE_API },
      ...setup,
      profiles: [
        makeProfile({ name: 'catalogue', kind: 'custom', components: ['bee-uploader'] }),
        makeProfile({ name: 'catalogue-two', kind: 'custom', components: ['bee-uploader'] }),
      ],
    });
    await t.store.move(
      { profileName: 'catalogue-two', batchId: NEXT_BATCH, batchDepth: 21, at: new Date(t.clock.now()) },
      1,
      'op',
    );
    return t;
  }

  it('pushes the batch moved to, and carries the batch moved from as previous, which the card reads too', async () => {
    const t = await moving();
    t.publisher.start();
    await settle();
    await t.clock.advance(CATALOGUE_CHECK_MS * 4);

    assert.ok(stores(t.sent).length > 0);
    for (const request of stores(t.sent)) {
      assert.equal(request.record.batchId, NEXT_BATCH);
      assert.equal(request.record.nodeName, 'catalogue-two');
      assert.equal(request.record.beeApiUrl, NEXT_BEE_API);
      assert.deepEqual(request.record.previous, {
        nodeName: 'catalogue',
        beeApiUrl: BEE_API,
        batchId: BATCH,
        immutable: true,
        depth: 20,
        state: 'active',
        ttlSeconds: 90 * 86_400,
        fillRatio: 2 / 16,
      });
      assert.ok(catalogueStampRecordSchema.safeParse(request.record).success);
    }
    const { reading, previousReading } = t.publisher.status();
    assert.equal(reading?.batchId, NEXT_BATCH);
    assert.equal(previousReading?.batchId, BATCH);
    assert.equal(previousReading?.state, 'active');
    assert.equal(previousReading?.depth, 20);
    assert.equal(t.state.readings % 2, 0, 'both batches are read on each round');
    t.publisher.stop();
  });

  it('pushes at the next check when the batch moved from is topped up, and not for its clock’s wear', async () => {
    const t = await moving();
    t.publisher.start();
    await settle();
    assert.equal(stores(t.sent).length, 1);

    t.state.byBatch.set(BATCH, readingOf({ ttl: 90 * 86_400 - 10 }));
    await t.clock.advance(CATALOGUE_CHECK_MS);
    assert.equal(stores(t.sent).length, 1, 'ten seconds of wear is no change');

    t.state.byBatch.set(BATCH, readingOf({ ttl: 200 * 86_400 }));
    await t.clock.advance(CATALOGUE_CHECK_MS);
    const sent = stores(t.sent);
    assert.equal(sent.length, 2, 'a top-up of the batch moved from is a change');
    assert.equal(sent[1]!.record.previous?.ttlSeconds, 200 * 86_400);
    assert.equal(sent[1]!.record.ttlSeconds, 90 * 86_400, 'the batch moved to reads as it did');

    t.state.byBatch.set(BATCH, readingOf({ ttl: 200 * 86_400, utilization: 9 }));
    await t.clock.advance(CATALOGUE_CHECK_MS);
    assert.equal(stores(t.sent).length, 3, 'a fill of the batch moved from is a change');
    t.publisher.stop();
  });

  it('leaves the batch moved from out when its node did not answer or reaches the dialling host alone', async () => {
    const t = await moving();
    t.state.byBatch.set(BATCH, { health: stampHealthFrom(BATCH, null), depth: null });
    t.publisher.start();
    await settle();
    assert.equal(stores(t.sent)[0]!.record.previous, null, 'a node that did not answer says nothing new');
    assert.equal(t.publisher.status().previousReading?.state, 'unknown', 'the card still says it');

    const loopback = await moving({
      beeApiUrls: { catalogue: 'http://127.0.0.1:1633', 'catalogue-two': NEXT_BEE_API },
    });
    loopback.publisher.start();
    await settle();
    assert.equal(stores(loopback.sent)[0]!.record.previous, null);
    t.publisher.stop();
    loopback.publisher.stop();
  });

  it('carries no previous once the move is released', async () => {
    const t = await moving();
    t.publisher.start();
    await settle();
    assert.ok(stores(t.sent)[0]!.record.previous);
    await t.store.release(new Date(t.clock.now()), 2, 'op');
    await t.publisher.pushNow();
    const last = stores(t.sent).at(-1)!;
    assert.equal(last.record.previous, null);
    assert.equal(last.record.batchId, NEXT_BATCH);
    t.publisher.stop();
  });

  it('keeps reading the batch moved from after a clear, and stops once it is released', async () => {
    const t = await moving();
    await t.store.clear(new Date(t.clock.now()), 2, 'op');
    t.publisher.start();
    await settle();
    assert.equal(t.publisher.status().previousReading?.batchId, BATCH);
    const readings = t.state.readings;
    await t.clock.advance(CATALOGUE_CHECK_MS);
    assert.equal(t.state.readings, readings + 1, 'the batch moved from alone is read while cleared');

    await t.store.release(new Date(t.clock.now()), 3, 'op');
    await t.clock.advance(CATALOGUE_CHECK_MS);
    assert.equal(t.publisher.status().previousReading, null);
    const after = t.state.readings;
    await t.clock.advance(CATALOGUE_CHECK_MS * 3);
    assert.equal(t.state.readings, after, 'nothing is read once the move is released and the designation cleared');
    t.publisher.stop();
  });
});

describe('stopping', () => {
  it('starts no call after stop', async () => {
    const t = await publisherFor();
    t.publisher.start();
    await settle();
    t.publisher.stop();
    const count = t.sent.length;
    await t.publisher.pushNow();
    await t.clock.advance(CATALOGUE_CHECK_MS * 6);
    assert.equal(t.sent.length, count);
  });
});

describe('the catalogue stamp record, with the address the manager pushes', () => {
  /** The pushed record's Bee API address, for one catalogue node and the host a pool string carries. */
  async function pushedAddress(profile: Profile, publisherHost: string): Promise<string | null> {
    const t = await publisherFor({
      profiles: [profile],
      published: publishedBeeApiUrl(async () => publisherHost),
    });
    t.publisher.start();
    await settle();
    const store = stores(t.sent)[0];
    return store && store.kind === 'store' ? store.record.beeApiUrl : null;
  }

  const local = (host: string | null) =>
    makeProfile({ name: 'catalogue', kind: 'custom', components: ['bee-uploader'], host, port_slot: 2 });

  it('carries the name host.docker.internal for a node on this host when the manager runs natively', async () => {
    // The admin dials it from another process or container, as an uploader dials a pool string.
    assert.equal(await pushedAddress(local(null), 'host.docker.internal'), 'http://host.docker.internal:10025');
    assert.equal(await pushedAddress(local('localhost'), 'host.docker.internal'), 'http://host.docker.internal:10025');
  });

  it('carries the bridge address a manager in a container resolves, as a pool string does', async () => {
    assert.equal(await pushedAddress(local(null), '172.17.0.1'), 'http://172.17.0.1:10025');
  });

  it("carries a declared remote host's own address", async () => {
    assert.equal(
      await pushedAddress(local('bee-host.example.invalid'), '172.17.0.1'),
      'http://bee-host.example.invalid:10025',
    );
  });
});

const ARCHIVE_BATCH = 'd3'.repeat(32);
const OLD_NODE_ARCHIVE_BATCH = 'd4'.repeat(32);

/** One archive batch as its node reads it: immutable, depth 22, a month of life. */
function archiveReadingOf(
  batchId: string,
  over: { ttl?: number; utilization?: number; usable?: boolean; depth?: number | null } = {},
): Reading {
  const stamp = {
    batchID: batchId,
    usable: over.usable ?? true,
    batchTTL: over.ttl ?? 30 * 86_400,
    depth: 22,
    bucketDepth: 16,
    utilization: over.utilization ?? 4,
    immutableFlag: true,
    exists: true,
  };
  return { health: stampHealthFrom(batchId, [stamp]), depth: over.depth === undefined ? 22 : over.depth };
}

/** A node that did not answer: the reading `StampService.batchReadingFor` gives then. */
const UNANSWERED: Reading = { health: stampHealthFrom(ARCHIVE_BATCH, null), depth: null };

function archiveRow(batchId: string, over: Partial<ArchiveBatchDesignation> = {}): ArchiveBatchDesignation {
  return {
    batchId,
    profileName: 'catalogue',
    depth: 22,
    label: 'Archive one',
    source: 'purchase',
    purchaseRequestId: '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6',
    designatedAt: '2026-10-01T09:00:00.000Z',
    designatedBy: null,
    ...over,
  };
}

const ARCHIVE_PROFILES = [
  makeProfile({ name: 'catalogue', kind: 'custom', components: ['bee-uploader'] }),
  makeProfile({ name: 'catalogue-old', kind: 'custom', components: ['bee-uploader'] }),
];

function lastRecord(sent: CatalogueRequest[]) {
  const last = stores(sent).at(-1);
  assert.ok(last && last.kind === 'store');
  return last.record;
}

describe('the archive batches on the catalogue stamp record', () => {
  it('carries every archive batch with its label, readings and designation, writable only on the catalogue node', async () => {
    const t = await publisherFor({
      profiles: ARCHIVE_PROFILES,
      archive: [
        archiveRow(ARCHIVE_BATCH),
        archiveRow(OLD_NODE_ARCHIVE_BATCH, {
          profileName: 'catalogue-old',
          label: null,
          source: 'adopted',
          purchaseRequestId: null,
          designatedAt: '2026-10-02T09:00:00.000Z',
          designatedBy: 'op',
        }),
      ],
    });
    t.state.byBatch.set(ARCHIVE_BATCH, archiveReadingOf(ARCHIVE_BATCH));
    t.state.byBatch.set(OLD_NODE_ARCHIVE_BATCH, archiveReadingOf(OLD_NODE_ARCHIVE_BATCH, { utilization: 16 }));
    t.publisher.start();
    await settle();
    const record = lastRecord(t.sent);
    assert.deepEqual(catalogueStampRecordSchema.parse(record), record);
    assert.deepEqual(record.archiveBatches, [
      {
        batchId: ARCHIVE_BATCH,
        label: 'Archive one',
        immutable: true,
        depth: 22,
        state: 'active',
        ttlSeconds: 30 * 86_400,
        fillRatio: 4 / 64,
        writable: true,
        designatedAt: '2026-10-01T09:00:00.000Z',
      },
      {
        batchId: OLD_NODE_ARCHIVE_BATCH,
        label: null,
        immutable: true,
        depth: 22,
        state: 'active',
        ttlSeconds: 30 * 86_400,
        fillRatio: 16 / 64,
        // A batch left on a node that is the catalogue node no longer is listed, and nothing is copied onto it.
        writable: false,
        designatedAt: '2026-10-02T09:00:00.000Z',
      },
    ]);
    t.publisher.stop();
  });

  it('carries an empty list when there is no archive batch, and leaves the field out without the list', async () => {
    const withList = await publisherFor({ archive: [] });
    withList.publisher.start();
    await settle();
    assert.deepEqual(lastRecord(withList.sent).archiveBatches, []);
    withList.publisher.stop();

    const without = await publisherFor();
    without.publisher.start();
    await settle();
    assert.equal('archiveBatches' in lastRecord(without.sent), false);
    without.publisher.stop();
  });

  it('is pushed at once when an archive batch is recorded, and at the next check when the list changes', async () => {
    const t = await publisherFor({ profiles: ARCHIVE_PROFILES, archive: [] });
    t.state.byBatch.set(ARCHIVE_BATCH, archiveReadingOf(ARCHIVE_BATCH));
    t.state.byBatch.set(OLD_NODE_ARCHIVE_BATCH, archiveReadingOf(OLD_NODE_ARCHIVE_BATCH));
    t.publisher.start();
    await settle();
    t.state.archive = [archiveRow(ARCHIVE_BATCH)];
    await t.publisher.pushNow();
    assert.equal(stores(t.sent).length, 2);
    assert.deepEqual(
      lastRecord(t.sent).archiveBatches?.map((batch) => batch.batchId),
      [ARCHIVE_BATCH],
    );
    t.state.archive = [archiveRow(ARCHIVE_BATCH), archiveRow(OLD_NODE_ARCHIVE_BATCH, { purchaseRequestId: null })];
    await t.clock.advance(CATALOGUE_CHECK_MS);
    assert.equal(stores(t.sent).length, 3, 'a batch added without a push is pushed at the next check');
    t.publisher.stop();
  });

  it('is pushed at the next check when an archive batch fills or is topped up, and not for its clock’s wear', async () => {
    const t = await publisherFor({ profiles: ARCHIVE_PROFILES, archive: [archiveRow(ARCHIVE_BATCH)] });
    t.state.byBatch.set(ARCHIVE_BATCH, archiveReadingOf(ARCHIVE_BATCH));
    t.publisher.start();
    await settle();
    t.state.byBatch.set(ARCHIVE_BATCH, archiveReadingOf(ARCHIVE_BATCH, { ttl: 30 * 86_400 - 10 }));
    await t.clock.advance(CATALOGUE_CHECK_MS);
    assert.equal(stores(t.sent).length, 1, 'ten seconds of wear is no change');
    t.state.byBatch.set(ARCHIVE_BATCH, archiveReadingOf(ARCHIVE_BATCH, { ttl: 60 * 86_400 }));
    await t.clock.advance(CATALOGUE_CHECK_MS);
    assert.equal(stores(t.sent).length, 2, 'a top-up is a change');
    t.state.byBatch.set(ARCHIVE_BATCH, archiveReadingOf(ARCHIVE_BATCH, { ttl: 60 * 86_400, utilization: 64 }));
    await t.clock.advance(CATALOGUE_CHECK_MS);
    assert.equal(stores(t.sent).length, 3, 'a full batch is a change');
    const [full] = lastRecord(t.sent).archiveBatches ?? [];
    assert.equal(full?.state, 'full');
    assert.equal(full?.writable, true);
    t.publisher.stop();
  });

  it('keeps the last depth of a batch whose node stops answering, as unknown and not writable', async () => {
    const t = await publisherFor({ profiles: ARCHIVE_PROFILES, archive: [archiveRow(ARCHIVE_BATCH)] });
    t.state.byBatch.set(ARCHIVE_BATCH, archiveReadingOf(ARCHIVE_BATCH));
    t.publisher.start();
    await settle();
    t.state.byBatch.set(ARCHIVE_BATCH, UNANSWERED);
    await t.clock.advance(CATALOGUE_CHECK_MS);
    const [batch] = lastRecord(t.sent).archiveBatches ?? [];
    assert.deepEqual(
      { state: batch?.state, depth: batch?.depth, writable: batch?.writable, ttlSeconds: batch?.ttlSeconds },
      { state: 'unknown', depth: 22, writable: false, ttlSeconds: null },
    );
    t.publisher.stop();
  });

  it('carries a batch whose node has not answered since a restart, with the depth the manager keeps', async () => {
    // A manager just started: nothing has been read from any node yet, and one node does not answer.
    const t = await publisherFor({
      profiles: ARCHIVE_PROFILES,
      archive: [
        archiveRow(ARCHIVE_BATCH),
        archiveRow(OLD_NODE_ARCHIVE_BATCH, { profileName: 'catalogue-old', depth: 24 }),
      ],
    });
    t.state.byBatch.set(ARCHIVE_BATCH, archiveReadingOf(ARCHIVE_BATCH));
    t.state.byBatch.set(OLD_NODE_ARCHIVE_BATCH, UNANSWERED);
    t.publisher.start();
    await settle();
    const carried = lastRecord(t.sent).archiveBatches ?? [];
    assert.deepEqual(
      carried.map((batch) => [batch.batchId, batch.state, batch.depth, batch.writable]),
      [
        [ARCHIVE_BATCH, 'active', 22, true],
        [OLD_NODE_ARCHIVE_BATCH, 'unknown', 24, false],
      ],
    );
    t.publisher.stop();
  });

  it('carries a batch whose deployment was deleted before the manager started', async () => {
    const t = await publisherFor({
      profiles: ARCHIVE_PROFILES,
      archive: [archiveRow(ARCHIVE_BATCH, { profileName: 'deleted-node', depth: 23 })],
    });
    t.publisher.start();
    await settle();
    const [batch] = lastRecord(t.sent).archiveBatches ?? [];
    assert.deepEqual(
      [batch?.batchId, batch?.state, batch?.depth, batch?.writable],
      [ARCHIVE_BATCH, 'unknown', 23, false],
    );
    assert.deepEqual(t.state.depthsRecorded, []);
    t.publisher.stop();
  });

  it('keeps a depth the node reports that differs from the one kept, as after a dilution', async () => {
    const t = await publisherFor({ profiles: ARCHIVE_PROFILES, archive: [archiveRow(ARCHIVE_BATCH)] });
    t.state.byBatch.set(ARCHIVE_BATCH, archiveReadingOf(ARCHIVE_BATCH));
    t.publisher.start();
    await settle();
    assert.deepEqual(t.state.depthsRecorded, [], 'the same depth is not written again');
    t.state.byBatch.set(ARCHIVE_BATCH, archiveReadingOf(ARCHIVE_BATCH, { depth: 23 }));
    await t.clock.advance(CATALOGUE_CHECK_MS);
    assert.deepEqual(t.state.depthsRecorded, [[ARCHIVE_BATCH, 23]]);
    assert.equal(lastRecord(t.sent).archiveBatches?.[0]?.depth, 23);
    // The node stops answering, and the record carries the depth kept since.
    t.state.byBatch.set(ARCHIVE_BATCH, UNANSWERED);
    await t.clock.advance(CATALOGUE_CHECK_MS);
    assert.equal(lastRecord(t.sent).archiveBatches?.[0]?.depth, 23);
    t.publisher.stop();
  });

  it('carries the first archive batches up to its maximum, and says so in the log once', async (t) => {
    const lines: string[] = [];
    t.mock.method(Logger.prototype, 'warn', (...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const many = Array.from({ length: CATALOGUE_ARCHIVE_BATCHES_MAX + 2 }, (_, index) =>
      archiveRow(index.toString(16).padStart(64, '0'), {
        designatedAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
      }),
    );
    const p = await publisherFor({ profiles: ARCHIVE_PROFILES, archive: many });
    p.publisher.start();
    await settle();
    await p.clock.advance(CATALOGUE_CHECK_MS);
    const carried = lastRecord(p.sent).archiveBatches ?? [];
    assert.equal(carried.length, CATALOGUE_ARCHIVE_BATCHES_MAX);
    assert.equal(carried[0]?.batchId, many[0]?.batchId);
    const truncations = lines.filter((line) => line.includes('carries the first'));
    assert.deepEqual(truncations.length, 1);
    assert.match(truncations[0] ?? '', new RegExp(`there are ${CATALOGUE_ARCHIVE_BATCHES_MAX + 2} archive batches`));
    p.publisher.stop();
  });

  it('reads a batch whose deployment is gone as unknown, and keeps the depth it had', async () => {
    const profiles = [...ARCHIVE_PROFILES];
    const t = await publisherFor({
      profiles,
      archive: [archiveRow(OLD_NODE_ARCHIVE_BATCH, { profileName: 'catalogue-old' })],
    });
    t.state.byBatch.set(OLD_NODE_ARCHIVE_BATCH, archiveReadingOf(OLD_NODE_ARCHIVE_BATCH));
    t.publisher.start();
    await settle();
    profiles.pop();
    await t.clock.advance(3 * CATALOGUE_CHECK_MS);
    const [batch] = lastRecord(t.sent).archiveBatches ?? [];
    assert.deepEqual([batch?.state, batch?.depth, batch?.writable], ['unknown', 22, false]);
    assert.equal(t.publisher.archiveStatus().readings.get(OLD_NODE_ARCHIVE_BATCH)?.state, 'unknown');
    t.publisher.stop();
  });

  it('pushes nothing when the list cannot be read, so the admin never hears there are none', async () => {
    const t = await publisherFor({ archive: [archiveRow(ARCHIVE_BATCH)] });
    t.state.byBatch.set(ARCHIVE_BATCH, archiveReadingOf(ARCHIVE_BATCH));
    t.publisher.start();
    await settle();
    t.state.archive = new Error('the database went away');
    await t.clock.advance(3 * CATALOGUE_CHECK_MS);
    assert.equal(stores(t.sent).length, 1);
    t.publisher.stop();
  });

  it('reports a list it cannot read while the node is read as a failed push, and leaves no rejection unhandled', async (t) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => void process.off('unhandledRejection', onUnhandled));
    const lines: string[] = [];
    t.mock.method(Logger.prototype, 'warn', (...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const p = await publisherFor({ archive: [archiveRow(ARCHIVE_BATCH)] });
    p.state.archive = new Error('the database went away');
    let answer!: () => void;
    p.state.readingGate = new Promise<void>((resolve) => (answer = resolve));
    p.publisher.start();
    await settle();
    answer();
    await settle();
    assert.deepEqual(unhandled, []);
    assert.equal(stores(p.sent).length, 0);
    assert.ok(
      lines.some((line) => line.includes('the push failed (the database went away)')),
      lines.join('\n'),
    );
    p.publisher.stop();
  });

  it('reads the archive batches for the settings page with no designation, and pushes nothing', async () => {
    const t = await publisherFor({
      designated: false,
      profiles: ARCHIVE_PROFILES,
      archive: [archiveRow(ARCHIVE_BATCH)],
    });
    t.state.byBatch.set(ARCHIVE_BATCH, archiveReadingOf(ARCHIVE_BATCH));
    t.publisher.start();
    await settle();
    assert.equal(stores(t.sent).length, 0);
    const reading = t.publisher.archiveStatus().readings.get(ARCHIVE_BATCH);
    assert.deepEqual([reading?.state, reading?.depth], ['active', 22]);
    t.publisher.stop();
  });
});
