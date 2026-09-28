/**
 * The catalogue publisher: when it pushes the brand's catalogue stamp record, what the record says, when it clears
 * it, and that one call never overtakes another.
 *
 * Unit test on a fake clock and a fake admin client, no database, no network. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type CataloguePushOutcome, type StampHealth, stampHealthFrom } from '@streaming-infra-manager/common';
import { catalogueStampRecordSchema } from '@streaming-monorepo/contracts';

import { EventBus } from '../../src/domain/EventBus.js';
import {
  CATALOGUE_CHECK_MS,
  CATALOGUE_TTL_DRIFT_SECONDS,
  CataloguePublisher,
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
  profiles?: Profile[];
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
  const state = { reading: readingOf(), readingDelayMs: 0, readings: 0 };
  const publisher = new CataloguePublisher({
    designation: store,
    profiles: { findByName: async (name) => profiles.find((profile) => profile.name === name) ?? null },
    reading: async () => {
      // A slow node: the record still says the moment its row was read.
      clock.time += state.readingDelayMs;
      state.readings += 1;
      return state.reading;
    },
    beeApiUrl: () => setup.beeApiUrl ?? BEE_API,
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

  it('is not sent for a node whose Bee API reaches the dialling host alone', async () => {
    for (const url of ['http://127.0.0.1:10025', 'http://localhost:10025', 'http://[::1]:10025']) {
      const t = await publisherFor({ beeApiUrl: url });
      await t.publisher.pushNow();
      assert.equal(t.sent.length, 0, url);
      assert.equal(t.publisher.status().lastPush?.outcome, 'skipped-no-record', url);
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

  async function moving() {
    const t = await publisherFor({
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

  it('pushes the batch moved to, and reads the batch moved from for the card alone', async () => {
    const t = await moving();
    t.publisher.start();
    await settle();
    await t.clock.advance(CATALOGUE_CHECK_MS * 4);

    assert.ok(stores(t.sent).length > 0);
    for (const request of stores(t.sent)) {
      assert.equal(request.record.batchId, NEXT_BATCH);
      assert.equal(request.record.nodeName, 'catalogue-two');
    }
    assert.equal(
      t.sent.some((request) => JSON.stringify(request).includes(BATCH)),
      false,
      'nothing of the batch moved from goes to the admin',
    );
    const { reading, previousReading } = t.publisher.status();
    assert.equal(reading?.batchId, NEXT_BATCH);
    assert.equal(previousReading?.batchId, BATCH);
    assert.equal(previousReading?.state, 'active');
    assert.equal(previousReading?.depth, 20);
    assert.equal(t.state.readings % 2, 0, 'both batches are read on each round');
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
