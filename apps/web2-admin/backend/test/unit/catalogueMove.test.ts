/**
 * Moving the catalogue's history onto another batch. Unit test: CatalogueMoveService with the real BeeFeedGateway and
 * bee-js against the fake Bee of `support/fakeBee.ts`, which records every chunk's address, bytes and batch, and the
 * stores in memory. `pnpm test`.
 *
 * Pinned here (docs/architecture/stages.md, "Moving the catalogue to another batch"): every slot from 0 to the head
 * lands under the new batch in order, byte for byte what was first written, from the recorded payload or from the
 * network; a wrapped slot's data and the latest entry's thumbnails go with it; writes made while the move goes
 * through its slices are caught up under the publish mutex before the admin switches to the new batch, and a write
 * waiting on that mutex goes with the new batch; a restart continues where the job stopped; a failure keeps its
 * reason and a retry continues; each refusal says why; nothing starts while CATALOGUE_MOVE_ENABLED is off; and the
 * start, the end and a failure are audited, with batch ids shortened in the log.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import type { CatalogueStampRecord } from '@streaming-monorepo/contracts';

import type { Actor } from '../../src/domain/actor.js';
import { BeeFeedGateway } from '../../src/domain/BeeFeedGateway.js';
import { CatalogueBatchService } from '../../src/domain/CatalogueBatch.js';
import { CatalogueMoveService } from '../../src/domain/CatalogueMove.js';
import { CatalogueMoveRefusedError } from '../../src/domain/errors/index.js';
import { encodeFeedPayload } from '../../src/domain/FeedGateway.js';
import { feedIdentityFrom } from '../../src/domain/feedIdentity.js';
import { Mutex } from '../../src/domain/Mutex.js';
import { PublishService } from '../../src/domain/PublishService.js';

import { FakeBee } from './support/fakeBee.js';
import { FakeRenditionStore, FakeStreamStore, InMemoryAuditLog, streamRow, TEST_OPERATOR } from './support/fakes.js';
import { FakeFeedWrites, FakeThumbnailStore, InMemoryCatalogueMoveStore } from './support/moveFakes.js';
import { catalogueStampRecord, FakeCatalogueStampStore, stagesWithMain } from './support/stageFakes.js';

/** Hardhat's first test account: public, and it signs nothing that matters. */
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TOPIC = 'swarm-stream';
const OLD = 'a1'.repeat(32);
const NEW = 'b2'.repeat(32);
const NOW = Date.parse('2026-09-28T10:05:00.000Z');
const feed = feedIdentityFrom(KEY, TOPIC);

let bee: FakeBee;
let gateway: BeeFeedGateway;
let stamps: FakeCatalogueStampStore;
let writes: FakeFeedWrites;
let store: InMemoryCatalogueMoveStore;
let thumbnails: FakeThumbnailStore;
let audit: InMemoryAuditLog;
let mutex: Mutex;
/** The chunk address of every slot written, by index. */
let addresses: string[];
const lines: string[] = [];
let restoreConsole: (() => void) | null = null;

function record(batchId: string, over: Partial<CatalogueStampRecord> = {}): CatalogueStampRecord {
  return catalogueStampRecord({ batchId, beeApiUrl: bee.url, ...over });
}

function service(options: { enabled?: boolean; sliceSlots?: number; mutex?: Mutex } = {}): CatalogueMoveService {
  return new CatalogueMoveService(store, stamps, writes, thumbnails, gateway, options.mutex ?? mutex, feed, audit, {
    enabled: options.enabled ?? true,
    now: () => NOW,
    sliceSlots: options.sliceSlots ?? 20,
  });
}

/** The catalogue as the admin writes it: through the pinned batch, under the publish mutex, recorded in the log. */
async function publish(entries: unknown[]): Promise<{ index: number; batchId: string | null }> {
  const batch = new CatalogueBatchService(stamps, writes, feed, audit, { stampRequired: true, now: () => NOW });
  return mutex.run(async () => {
    const target = await batch.forWrite(TEST_OPERATOR);
    const last = await writes.lastWrite(feed.owner, feed.topicHex);
    const index = last ? last.index + 1 : 0;
    const payloadText = encodeFeedPayload(entries);
    const reference = await gateway.write(payloadText, index, target);
    addresses[index] = reference;
    await writes.record({
      owner: feed.owner,
      topic: feed.topicHex,
      feedIndex: index,
      entryCount: entries.length,
      payload: entries,
      payloadText,
      reference,
      batchId: target?.batchId ?? null,
    });
    return { index, batchId: target?.batchId ?? null };
  });
}

/**
 * `count` slots written with OLD, pinned, and then the manager designates NEW. `legacy` slots keep no payload and no
 * batch, as rows from before migration 013 do; `unlisted` slots have no row at all, as those from before 003.
 */
async function history(
  count: number,
  options: { legacy?: number[]; unlisted?: number[]; entries?: (index: number) => unknown[] } = {},
): Promise<void> {
  await stamps.upsert(record(OLD));
  await stamps.pin(record(OLD));
  for (let index = 0; index < count; index += 1) {
    const entries = options.entries?.(index) ?? [{ topic: `stream-${index}`, title: `Slot ${index}`, thumbnail: '' }];
    const payloadText = encodeFeedPayload(entries);
    const reference = await gateway.write(payloadText, index, { beeApiUrl: bee.url, batchId: OLD });
    addresses[index] = reference;
    if (options.unlisted?.includes(index)) continue;
    const legacy = options.legacy?.includes(index) ?? false;
    await writes.record({
      owner: feed.owner,
      topic: feed.topicHex,
      feedIndex: index,
      entryCount: entries.length,
      payload: entries,
      payloadText: legacy ? null : payloadText,
      reference: legacy ? null : reference,
      batchId: legacy ? null : OLD,
    });
  }
  await stamps.upsert(record(NEW, { observedAt: '2026-09-28T10:01:00.000Z' }));
}

/** The single-owner chunks a batch holds, by address. */
function socsUnder(batch: string): Map<string, string> {
  return new Map(bee.under(batch, 'soc').map((u) => [u.address, Buffer.from(u.bytes).toString('hex')]));
}

function assertEverySlotMoved(count: number): void {
  const before = socsUnder(OLD);
  const after = socsUnder(NEW);
  for (let index = 0; index < count; index += 1) {
    const address = addresses[index]!;
    assert.ok(after.has(address), `slot ${index} is under the new batch`);
    assert.equal(after.get(address), before.get(address), `slot ${index} is byte for byte what was written`);
  }
}

function actions(): string[] {
  return audit.entries.map((entry) => entry.action).filter((action) => action.startsWith('catalogue.move'));
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

before(async () => {
  bee = await new FakeBee().start();
});

after(async () => {
  await bee.stop();
});

beforeEach(() => {
  bee.uploads.length = 0;
  bee.chunks.clear();
  bee.files.clear();
  bee.failNext = null;
  bee.beforeAnswer = null;
  gateway = new BeeFeedGateway({ feedPrivateKey: KEY, feedTopic: TOPIC });
  stamps = new FakeCatalogueStampStore();
  writes = new FakeFeedWrites();
  store = new InMemoryCatalogueMoveStore(writes);
  thumbnails = new FakeThumbnailStore();
  audit = new InMemoryAuditLog();
  mutex = new Mutex();
  addresses = [];
  lines.length = 0;
  const keep = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  const methods = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => mock.method(console, name, keep));
  restoreConsole = () => methods.forEach((method) => method.mock.restore());
});

afterEach(() => {
  restoreConsole?.();
  restoreConsole = null;
  const everything = lines.join('\n');
  assert.equal(everything.includes(OLD), false, 'a whole batch id reached the log');
  assert.equal(everything.includes(NEW), false, 'a whole batch id reached the log');
});

describe('a move of the catalogue', () => {
  it('stamps every slot again under the new batch, in order and byte for byte, then writes with it', async () => {
    // Slot 2 has no recorded bytes, slot 4 no row at all, slot 5 is over 4096 bytes and wrapped.
    const long = Array.from({ length: 90 }, (_, i) => ({ topic: `long-${i}`, title: `Élő adás ${i}` }));
    await history(7, {
      legacy: [2],
      unlisted: [4],
      entries: (index) => (index === 5 ? long : [{ topic: `s${index}` }]),
    });
    const moving = service({ sliceSlots: 3 });

    const waiting = await moving.status();
    assert.deepEqual(waiting.waiting, { targetBatchId: NEW, fromBatchId: OLD, slots: 7 });
    assert.equal(waiting.refusal, null);

    await moving.start(TEST_OPERATOR, NEW);
    await moving.settled();

    assertEverySlotMoved(7);
    assert.deepEqual(
      bee.under(NEW, 'soc').map((upload) => upload.address),
      addresses.slice(0, 7),
      'the slots go under the new batch in order, each once',
    );
    const oldData = new Map(bee.under(OLD, 'chunk').map((u) => [u.address, Buffer.from(u.bytes).toString('hex')]));
    const newData = new Map(bee.under(NEW, 'chunk').map((u) => [u.address, Buffer.from(u.bytes).toString('hex')]));
    assert.deepEqual(newData, oldData, 'the wrapped slot’s data, chunk for chunk');

    assert.equal(stamps.row?.active_batch_id, NEW, 'the admin writes with the new batch');
    const done = await moving.status();
    assert.equal(done.waiting, null);
    assert.equal(done.latest?.state, 'done');
    assert.equal(done.latest?.slotsDone, 7);
    assert.equal(done.latest?.slotsTotal, 7);
    assert.equal(done.latest?.restamped, 7);
    assert.deepEqual(
      writes.rows.filter((row) => row.restampedBatchId === NEW).map((row) => row.feedIndex),
      [0, 1, 2, 3, 5, 6],
      'every row is marked; the slot with no row is covered by the move',
    );
    assert.deepEqual(actions(), ['catalogue.move.start', 'catalogue.move.done']);
    assert.deepEqual(audit.withAction('catalogue.move.start')[0]?.details, {
      moveId: '1',
      targetBatchId: NEW,
      fromBatchId: OLD,
      slots: 7,
      fromSlot: 0,
      retry: false,
    });
    assert.equal(audit.withAction('catalogue.move.done')[0]?.details?.switched, true);

    const next = await publish([{ topic: 'after' }]);
    assert.deepEqual(next, { index: 7, batchId: NEW });
    assert.equal((await moving.status()).waiting, null, 'a slot written after the move is already under the new batch');
  });

  it('uploads every thumbnail a stream or the latest entry names again, from the admin’s bytes or the network', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10]);
    const jpeg = new Uint8Array([255, 216, 255, 224]);
    const gif = new Uint8Array([71, 73, 70, 56]);
    // A draft's image, on no catalogue entry: published again after the move, it names the same reference.
    const draft = await gateway.uploadThumbnail(gif, 'draft.gif', 'image/gif', { beeApiUrl: bee.url, batchId: OLD });
    thumbnails.byRef.set(draft, { thumbnail: Buffer.from(gif), thumbnail_mime: 'image/gif', topic: 'draft' });
    const stored = await gateway.uploadThumbnail(png, 'kept.png', 'image/png', { beeApiUrl: bee.url, batchId: OLD });
    const lost = await gateway.uploadThumbnail(jpeg, 'lost.jpg', 'image/jpeg', { beeApiUrl: bee.url, batchId: OLD });
    thumbnails.byRef.set(stored, { thumbnail: Buffer.from(png), thumbnail_mime: 'image/png', topic: 'kept' });
    await history(2, {
      entries: (index) =>
        index === 1
          ? [
              { topic: 'kept', thumbnail: stored },
              { topic: 'lost', thumbnail: lost },
              { topic: 'none', thumbnail: '' },
            ]
          : [{ topic: 'first', thumbnail: '' }],
    });
    const moving = service();

    await moving.start(TEST_OPERATOR, NEW);
    await moving.settled();

    assert.deepEqual(
      bee
        .under(NEW, 'file')
        .map((u) => u.address)
        .sort(),
      [stored, lost, draft].sort(),
      'every thumbnail, at the reference it had',
    );
    assert.equal((await moving.status()).latest?.thumbnails, 3);
    assert.deepEqual(
      [...thumbnails.batches].sort(),
      [
        [draft, NEW],
        [stored, NEW],
      ].sort(),
      'the streams that name one are told it is under the new batch',
    );
  });

  it('refuses to switch when a thumbnail comes out at another reference, and says which', async () => {
    const png = new Uint8Array([1, 2, 3]);
    const reference = await gateway.uploadThumbnail(png, 'a.png', 'image/png', { beeApiUrl: bee.url, batchId: OLD });
    // A row that still names the reference with other bytes: the guard, not a state the admin makes.
    thumbnails.byRef.set(reference, { thumbnail: Buffer.from([9, 9, 9]), thumbnail_mime: 'image/png', topic: 'a' });
    await history(1, { entries: () => [{ topic: 'a', thumbnail: reference }] });
    const moving = service();

    await moving.start(TEST_OPERATOR, NEW);
    await moving.settled();

    const status = await moving.status();
    assert.equal(status.latest?.state, 'failed');
    assert.match(status.latest?.error ?? '', new RegExp(`The thumbnail ${reference} came out as`));
    assert.equal(stamps.row?.active_batch_id, OLD, 'nothing was switched');
  });

  it('goes through the history in slices outside the publish mutex, and catches up a write made meanwhile', async () => {
    await history(6);
    const moving = service({ sliceSlots: 2 });
    let written: { index: number; batchId: string | null } | null = null;
    bee.beforeAnswer = async (upload) => {
      if (upload.batch !== NEW || upload.address !== addresses[1] || written) return;
      // The publish mutex is free while the move goes through its slices: this write does not wait for the move.
      written = await Promise.race([
        publish([{ topic: 'written during the move' }]),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the publish mutex was held')), 2000)),
      ]);
    };

    await moving.start(TEST_OPERATOR, NEW);
    await moving.settled();

    assert.deepEqual(written, { index: 6, batchId: OLD }, 'written with the pinned batch while the move ran');
    assertEverySlotMoved(7);
    assert.equal(stamps.row?.active_batch_id, NEW);
    assert.equal((await moving.status()).latest?.slotsDone, 7);
  });

  it('holds a write that comes during the last step until the switch, and that write goes with the new batch', async () => {
    await history(3);
    const moving = service({ sliceSlots: 20 });
    let waiting: Promise<{ index: number; batchId: string | null }> | null = null;
    bee.beforeAnswer = (upload) => {
      // The whole history fits the last step, which holds the mutex: this write queues behind it.
      if (upload.batch === NEW && upload.address === addresses[0] && !waiting) waiting = publish([{ topic: 'late' }]);
    };

    await moving.start(TEST_OPERATOR, NEW);
    await moving.settled();

    assert.ok(waiting, 'a write was attempted during the last step');
    assert.deepEqual(await waiting, { index: 3, batchId: NEW }, 'no slot was written with the old batch alone');
    assert.equal((await moving.status()).waiting, null);
  });

  it('continues where it stopped after the process died, uploading no slot twice', async () => {
    await history(5);
    const first = service({ sliceSlots: 2 });
    let dead: () => void = () => undefined;
    const died = new Promise<void>((resolve) => (dead = resolve));
    bee.beforeAnswer = (upload) => {
      if (upload.batch !== NEW || upload.address !== addresses[3]) return undefined;
      // The first process's upload of slot 3 is never answered: the process is gone.
      dead();
      return new Promise<void>(() => undefined);
    };

    await first.start(TEST_OPERATOR, NEW);
    await died;
    assert.equal((await store.latest(feed.owner, feed.topicHex))?.nextIndex, 3);
    // A new process boots on the same database and node.
    bee.beforeAnswer = null;
    const restarted = service({ sliceSlots: 2, mutex: new Mutex() });
    await restarted.resumeOnBoot();
    await restarted.settled();

    assertEverySlotMoved(5);
    const uploads = bee.under(NEW, 'soc').map((upload) => upload.address);
    assert.deepEqual(uploads, addresses.slice(0, 5), 'slots 0 to 2 were not uploaded again');
    assert.equal((await restarted.status()).latest?.state, 'done');
    assert.deepEqual(actions(), ['catalogue.move.start', 'catalogue.move.done']);
  });

  it('stops at a slot the node refuses, with the reason and no node address, and a retry continues there', async () => {
    await history(4);
    const moving = service({ sliceSlots: 2 });
    let refused = false;
    bee.beforeAnswer = (upload) => {
      if (upload.batch === NEW && upload.address === addresses[2] && !refused) {
        refused = true;
        bee.failNext = { kind: 'soc', status: 500 };
      }
    };

    await moving.start(TEST_OPERATOR, NEW);
    await moving.settled();

    const failed = await moving.status();
    assert.equal(failed.latest?.state, 'failed');
    assert.equal(failed.latest?.slotsDone, 2);
    assert.equal(failed.latest?.error, 'Slot 2 could not be moved: the node answered 500 to the upload of slot 2');
    assert.equal(stamps.row?.active_batch_id, OLD, 'still written with the old batch');
    assert.deepEqual(audit.withAction('catalogue.move.failed')[0]?.details, {
      moveId: '1',
      targetBatchId: NEW,
      fromBatchId: OLD,
      atSlot: 2,
      error: failed.latest?.error,
    });

    await moving.start(TEST_OPERATOR, NEW);
    await moving.settled();

    assertEverySlotMoved(4);
    assert.deepEqual(
      bee.under(NEW, 'soc').map((upload) => upload.address),
      addresses.slice(0, 4),
      'the retry started at slot 2',
    );
    assert.equal((await moving.status()).latest?.state, 'done');
    assert.equal(audit.withAction('catalogue.move.start')[1]?.details?.retry, true);
    assert.equal(audit.withAction('catalogue.move.start')[1]?.details?.fromSlot, 2);
  });

  it('stops when the manager designates yet another batch while it runs, and does not switch', async () => {
    await history(4);
    const moving = service({ sliceSlots: 1 });
    bee.beforeAnswer = async (upload) => {
      if (upload.batch === NEW && upload.address === addresses[0]) {
        await stamps.upsert(record('c3'.repeat(32), { observedAt: '2026-09-28T10:02:00.000Z' }));
      }
    };

    await moving.start(TEST_OPERATOR, NEW);
    await moving.settled();

    const status = await moving.status();
    assert.equal(status.latest?.state, 'failed');
    assert.match(
      status.latest?.error ?? '',
      /The manager designated batch c3c3c3c3… while the catalogue was being moved to b2b2b2b2…/,
    );
    assert.equal(stamps.row?.active_batch_id, OLD);
  });

  it('moves only the writes no recorded batch stamped when the pinned batch is the designated one', async () => {
    await stamps.upsert(record(NEW));
    await stamps.pin(record(NEW));
    for (let index = 0; index < 3; index += 1) {
      const entries = [{ topic: `s${index}` }];
      const payloadText = encodeFeedPayload(entries);
      addresses[index] = await gateway.write(payloadText, index, { beeApiUrl: bee.url, batchId: OLD });
      await writes.record({
        owner: feed.owner,
        topic: feed.topicHex,
        feedIndex: index,
        entryCount: 1,
        payload: entries,
        payloadText: index === 2 ? payloadText : null,
        reference: addresses[index]!,
        // Slots 0 and 1 are from before the catalogue stamp; slot 2 was written with the pinned batch.
        batchId: index === 2 ? NEW : null,
      });
    }
    const moving = service();

    assert.deepEqual((await moving.status()).waiting, { targetBatchId: NEW, fromBatchId: NEW, slots: 3 });
    await moving.start(TEST_OPERATOR, NEW);
    await moving.settled();

    assert.deepEqual(
      bee.under(NEW, 'soc').map((upload) => upload.address),
      [addresses[0], addresses[1]],
      'slots 0 and 1 moved, and slot 2 left as it was written',
    );
    const latest = (await moving.status()).latest;
    assert.equal(latest?.restamped, 2);
    assert.equal(latest?.skipped, 1);
    assert.equal((await moving.status()).waiting, null);
  });
});

describe('a move that cannot start', () => {
  async function refusal(moving: CatalogueMoveService, batch = NEW): Promise<CatalogueMoveRefusedError> {
    const error = await moving.start(TEST_OPERATOR, batch).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error instanceof CatalogueMoveRefusedError, `refused, got ${String(error)}`);
    assert.equal(store.moves.length, 0, 'nothing was started');
    return error;
  }

  it('is refused while CATALOGUE_MOVE_ENABLED is off, and the page says so', async () => {
    await history(2);
    const moving = service({ enabled: false });

    const status = await moving.status();
    assert.equal(status.enabled, false);
    assert.deepEqual(status.waiting, { targetBatchId: NEW, fromBatchId: OLD, slots: 2 });
    assert.equal(status.refusal?.problem, 'disabled');
    assert.match(status.refusal?.message ?? '', /not yet enabled on this installation/);
    assert.equal((await refusal(moving)).problem, 'disabled');
    assert.equal(bee.under(NEW).length, 0);
  });

  it('is refused with no designation, or a cleared one', async () => {
    const moving = service();
    assert.equal((await refusal(moving)).problem, 'none');
    await history(1);
    await stamps.clear('2026-09-28T10:03:00.000Z');
    assert.equal((await refusal(moving)).problem, 'cleared');
  });

  it('is refused when every slot is under the designated batch already', async () => {
    await stamps.upsert(record(OLD));
    await publish([{ topic: 'a' }]);
    const moving = service();
    assert.equal((await moving.status()).waiting, null);
    assert.equal((await refusal(moving, OLD)).problem, 'nothing');
  });

  it('is refused when the batch to move to cannot be written with', async () => {
    await history(1);
    await stamps.upsert(record(NEW, { state: 'expired', observedAt: '2026-09-28T10:02:00.000Z' }));
    const error = await refusal(service());
    assert.equal(error.problem, 'target');
    assert.match(error.message, /The catalogue batch b2b2b2b2… is expired/);
  });

  it('is refused when the old batch lapsed and some slot has no recorded bytes', async () => {
    await history(3, { legacy: [1] });
    stamps.row!.active_record = { ...stamps.row!.active_record!, state: 'expired' };
    const error = await refusal(service());
    assert.equal(error.problem, 'lapsed');
    assert.match(error.message, /a1a1a1a1…, has lapsed, and 1 slot has no recorded bytes/);
  });

  it('still starts when the old batch lapsed but every slot has its bytes recorded', async () => {
    await history(3);
    const before = socsUnder(OLD);
    stamps.row!.active_record = { ...stamps.row!.active_record!, state: 'gone' };
    bee.lapse(OLD);
    const moving = service();

    await moving.start(TEST_OPERATOR, NEW);
    await moving.settled();

    assert.deepEqual(socsUnder(NEW), before);
    assert.equal((await moving.status()).latest?.state, 'done');
  });

  it('is refused when the page named another batch than the designated one', async () => {
    await history(1);
    assert.equal((await refusal(service(), 'c3'.repeat(32))).problem, 'changed');
  });
});

describe('a move at boot', () => {
  it('fails a move left running once CATALOGUE_MOVE_ENABLED is off, with that reason, and audits it', async () => {
    await history(2);
    await store.create({
      owner: feed.owner,
      topic: feed.topicHex,
      targetBatchId: NEW,
      fromBatchId: OLD,
      startedBy: 'a',
    });

    await service({ enabled: false }).resumeOnBoot();

    const latest = await store.latest(feed.owner, feed.topicHex);
    assert.equal(latest?.state, 'failed');
    assert.match(latest?.error ?? '', /not yet enabled on this installation.*can be retried once it is/);
    const [failed] = audit.withAction('catalogue.move.failed');
    assert.deepEqual((failed?.actor as Actor | undefined)?.kind, 'system');
    assert.equal(bee.under(NEW).length, 0);
  });

  it('pauses on shutdown after the slot it is on, leaving the move running for the next start', async () => {
    await history(4);
    const moving = service({ sliceSlots: 1 });
    let stopping: Promise<void> | null = null;
    bee.beforeAnswer = (upload) => {
      if (upload.batch === NEW && upload.address === addresses[1] && !stopping) stopping = moving.shutdown();
    };

    await moving.start(TEST_OPERATOR, NEW);
    await waitFor(() => stopping !== null, 'the shutdown');
    await stopping;

    const latest = await store.latest(feed.owner, feed.topicHex);
    assert.equal(latest?.state, 'running');
    assert.equal(latest?.nextIndex, 2);
    assert.deepEqual(actions(), ['catalogue.move.start']);
  });
});

describe('a move that is still owed', () => {
  it('waits for the switch back when the manager moves back to a batch that still holds every slot', async () => {
    // X → Y, moved; then the manager moves back to X before anything is published. Every slot is still under X by
    // its row, but the admin writes with Y: "nothing to move" would leave it there for ever.
    await history(3);
    const moving = service();
    await moving.start(TEST_OPERATOR, NEW);
    await moving.settled();
    assert.equal(stamps.row?.active_batch_id, NEW);
    await stamps.upsert(record(OLD, { observedAt: '2026-09-28T10:02:00.000Z' }));

    const back = await moving.status();
    assert.deepEqual(back.waiting, { targetBatchId: OLD, fromBatchId: NEW, slots: 3 });
    assert.equal(back.refusal, null);
    const uploadsBefore = bee.under(OLD, 'soc').length;

    await moving.start(TEST_OPERATOR, OLD);
    await moving.settled();

    const done = await moving.status();
    assert.equal(done.latest?.state, 'done');
    assert.equal(done.latest?.targetBatchId, OLD);
    assert.equal(done.latest?.skipped, 3, 'every slot was already under it');
    assert.equal(bee.under(OLD, 'soc').length, uploadsBefore, 'no slot uploaded again');
    assert.equal(stamps.row?.active_batch_id, OLD, 'switched back');
    assert.equal(done.waiting, null);
    assert.deepEqual([done.designatedBatchId, done.pinnedBatchId], [OLD, OLD]);
  });

  it('lets a move that failed after its last slot be retried, and finishes it without uploading a slot again', async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const gif = new Uint8Array([71, 73, 70]);
    const late = await gateway.uploadThumbnail(gif, 'late.gif', 'image/gif', { beeApiUrl: bee.url, batchId: OLD });
    const reference = await gateway.uploadThumbnail(png, 'a.png', 'image/png', { beeApiUrl: bee.url, batchId: OLD });
    thumbnails.byRef.set(reference, { thumbnail: Buffer.from(png), thumbnail_mime: 'image/png', topic: 'a' });
    await history(3, { entries: (index) => [{ topic: 'a', title: `v${index}`, thumbnail: reference }] });
    // Slots 0 and 1 go in slices; slot 2 and the last thumbnails in the last step, where the thumbnail fails.
    const moving = service({ sliceSlots: 1 });
    let armed = false;
    bee.beforeAnswer = (upload) => {
      if (upload.kind === 'soc' && upload.batch === NEW && upload.address === addresses[2] && !armed) {
        armed = true;
        // A draft's new image, uploaded while the move ran, which the last step has to move as well.
        thumbnails.byRef.set(late, { thumbnail: Buffer.from(gif), thumbnail_mime: 'image/gif', topic: 'late' });
        bee.failNext = { kind: 'file', status: 500, batch: NEW };
      }
    };

    await moving.start(TEST_OPERATOR, NEW);
    await moving.settled();

    const failed = await moving.status();
    assert.equal(failed.latest?.state, 'failed');
    assert.equal(failed.latest?.slotsDone, 3, 'every slot was recorded before the thumbnail step failed');
    assert.match(failed.latest?.error ?? '', new RegExp(`The thumbnail ${late} could not be uploaded again`));
    assert.deepEqual(failed.waiting, { targetBatchId: NEW, fromBatchId: OLD, slots: 3 }, 'still owed, not "nothing"');
    assert.equal(failed.refusal, null);
    assert.equal(stamps.row?.active_batch_id, OLD);

    await moving.start(TEST_OPERATOR, NEW);
    await moving.settled();

    const done = await moving.status();
    assert.equal(done.latest?.state, 'done');
    assert.equal(bee.under(NEW, 'soc').length, 3, 'each slot uploaded once');
    // A retry goes through the thumbnails again: an upload of the same file under the same batch changes nothing.
    assert.deepEqual(
      [...new Set(bee.under(NEW, 'file').map((upload) => upload.address))].sort(),
      [reference, late].sort(),
    );
    assert.equal(stamps.row?.active_batch_id, NEW);
  });

  it('refuses a start while the move is off even when a move is left running, and resumes nothing', async () => {
    await history(2);
    await store.create({
      owner: feed.owner,
      topic: feed.topicHex,
      targetBatchId: NEW,
      fromBatchId: OLD,
      startedBy: 'a',
    });
    const moving = service({ enabled: false });

    const error = await moving.start(TEST_OPERATOR, NEW).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(error instanceof CatalogueMoveRefusedError);
    assert.equal(error.problem, 'disabled');
    await moving.settled();
    assert.equal(bee.under(NEW).length, 0, 'nothing was uploaded');
    assert.equal((await store.latest(feed.owner, feed.topicHex))?.nextIndex, 0);
  });

  it('uploads a slot adopted from the network at boot as the network holds it, not signed again from its text', async () => {
    await history(2);
    // Slot 1 as the boot check adopts a head: the text a node answered, no reference and no batch.
    writes.rows[1]!.reference = null;
    writes.rows[1]!.batchId = null;
    writes.rows[1]!.payloadText = '[{"topic":"what the node said"}]';
    const moving = service();

    await moving.start(TEST_OPERATOR, NEW);
    await moving.settled();

    assertEverySlotMoved(2);
  });

  it('stops counting writes with no recorded batch once a move has uploaded them under the pinned batch', async () => {
    await history(3, { legacy: [0, 1] });
    const batch = new CatalogueBatchService(stamps, writes, feed, audit, { stampRequired: true, now: () => NOW });
    assert.deepEqual((await batch.status()).unrecordedHistory, { writes: 2 });

    const moving = service();
    await moving.start(TEST_OPERATOR, NEW);
    await moving.settled();

    assert.equal((await batch.status()).unrecordedHistory, null);
  });
});

describe('a thumbnail after a move', () => {
  it('is under the new batch when a stream unpublished before the move is published again', async () => {
    await stamps.upsert(record(OLD));
    const renditions = new FakeRenditionStore();
    const streams = new FakeStreamStore(renditions);
    const batch = new CatalogueBatchService(stamps, writes, feed, audit, { stampRequired: true, now: () => NOW });
    const publishing = new PublishService(
      streams,
      renditions,
      stagesWithMain(),
      writes,
      gateway,
      batch,
      feed,
      audit,
      mutex,
    );
    const png = new Uint8Array([137, 80, 78, 71, 5, 6, 7]);
    const row = streams.add(streamRow({ owner: feed.owner, has_thumbnail: true, thumbnail_mime: 'image/png' }), {
      thumbnail: Buffer.from(png),
      thumbnail_mime: 'image/png',
    });

    await publishing.publish(TEST_OPERATOR, row.id);
    const reference = streams.get(row.id).thumbnail_ref!;
    assert.equal(streams.get(row.id).thumbnail_batch_id, OLD);
    await publishing.unpublish(TEST_OPERATOR, row.id);

    await stamps.upsert(record(NEW, { observedAt: '2026-09-28T10:01:00.000Z' }));
    const moving = new CatalogueMoveService(store, stamps, writes, streams, gateway, mutex, feed, audit, {
      enabled: true,
      now: () => NOW,
    });
    await moving.start(TEST_OPERATOR, NEW);
    await moving.settled();
    assert.equal((await moving.status()).latest?.state, 'done');
    assert.equal(streams.get(row.id).thumbnail_batch_id, NEW, 'the draft’s image was moved too');

    await publishing.publish(TEST_OPERATOR, row.id);

    assert.equal(streams.get(row.id).thumbnail_ref, reference, 'the same image, at the same reference');
    assert.ok(
      bee.under(NEW, 'file').some((upload) => upload.address === reference),
      'the thumbnail is under the new batch',
    );
    const entries = (await writes.lastWrite(feed.owner, feed.topicHex))?.entries as { thumbnail: string }[];
    assert.equal(entries[0]?.thumbnail, reference);
    assert.equal(writes.rows.at(-1)?.batchId, NEW);
  });

  it('is uploaded again by a publish when it was uploaded under another batch than the catalogue’s', async () => {
    await stamps.upsert(record(OLD));
    const renditions = new FakeRenditionStore();
    const streams = new FakeStreamStore(renditions);
    const batch = new CatalogueBatchService(stamps, writes, feed, audit, { stampRequired: true, now: () => NOW });
    const publishing = new PublishService(
      streams,
      renditions,
      stagesWithMain(),
      writes,
      gateway,
      batch,
      feed,
      audit,
      mutex,
    );
    const png = new Uint8Array([1, 1, 2, 3, 5]);
    const row = streams.add(streamRow({ owner: feed.owner, has_thumbnail: true, thumbnail_mime: 'image/png' }), {
      thumbnail: Buffer.from(png),
      thumbnail_mime: 'image/png',
    });
    await publishing.publish(TEST_OPERATOR, row.id);
    // The row says another batch holds it, as one from before migration 014 says none.
    streams.add({ ...streams.get(row.id), thumbnail_batch_id: 'c3'.repeat(32) });
    const before = bee.under(OLD, 'file').length;

    await publishing.publish(TEST_OPERATOR, row.id);

    assert.equal(bee.under(OLD, 'file').length, before + 1, 'uploaded again under the catalogue’s batch');
    assert.equal(streams.get(row.id).thumbnail_batch_id, OLD);
  });
});
