import type { FundingBatch, FundingInventory, FundingNode } from '@streaming-monorepo/contracts';
import {
  AUTO_TOPUP_DEFAULTS,
  SECONDS_PER_DAY,
  UNMARKED_STAMP_HOLDERS,
  UNMARKED_STAMP_LEVELS,
  type Notice,
  type NoticeTopic,
  type UnmarkedStampLevel,
} from '@streaming-monorepo/web2-admin-common';

import type { AutoTopUpMarkRow } from '../../../src/domain/funding/StampAutoTopUpStore.js';
import type {
  UnmarkedStampReading,
  UnmarkedStampRow,
  UnmarkedStampStore,
} from '../../../src/domain/funding/UnmarkedStampStore.js';
import { markedStampsOf, type AutoTopUpTickContext } from '../../../src/domain/funding/autoTopUpJobs.js';
import type {
  NotifyOutcome,
  Notifier,
  OutgoingNotice,
  RetryOutcome,
} from '../../../src/domain/notifications/Notifier.js';

import {
  BATCH_CATALOGUE,
  BATCH_RUNG,
  BATCH_STAGE,
  NODE_B,
  NODE_CATALOGUE,
  NODE_RUNG,
  POSTAGE,
  fundingBatch,
  fundingInventory,
  fundingNode,
} from './fundingFakes.js';

/** A batch id as migration 037 takes it: `0x` and 64 lower-case hex digits. */
const BATCH_ID = /^0x[0-9a-f]{64}$/;
/** A node id as migration 037 takes it, the manager's own. */
const NODE_ID = /^[A-Za-z0-9:._-]{1,200}$/;

/**
 * The unmarked stamps running low, in memory, with the checks of migration 037 that matter to a caller: a batch id is
 * `0x` and 64 lower-case hex digits, a node id the manager's, a holder and a level one the table takes, a message never
 * empty, and a level's moment never before its `since`. It keeps the rows as the repository does: a reading of a stamp
 * with a row takes its node, holder and message, keeps its `since` and what it was notified of, and moves
 * `levelSince` only when its level changed.
 */
export class InMemoryUnmarkedStampStore implements UnmarkedStampStore {
  readonly watched = new Map<string, UnmarkedStampRow>();

  async rows(): Promise<UnmarkedStampRow[]> {
    return [...this.watched.values()]
      .sort((a, b) => a.since.getTime() - b.since.getTime() || a.batchId.localeCompare(b.batchId))
      .map((row) => ({ ...row }));
  }

  async record(reading: UnmarkedStampReading, at: Date): Promise<void> {
    if (!BATCH_ID.test(reading.batchId)) throw new Error(`stamp_watch_notices CHECK batch_id: ${reading.batchId}`);
    if (!NODE_ID.test(reading.nodeId)) throw new Error(`stamp_watch_notices CHECK node_id: ${reading.nodeId}`);
    if (!UNMARKED_STAMP_HOLDERS.includes(reading.holder)) throw new Error('stamp_watch_notices CHECK holder');
    if (!UNMARKED_STAMP_LEVELS.includes(reading.level)) throw new Error('stamp_watch_notices CHECK level');
    if (reading.message === '') throw new Error('stamp_watch_notices CHECK message');
    const row = this.watched.get(reading.batchId);
    if (!row) {
      this.watched.set(reading.batchId, {
        ...reading,
        since: at,
        levelSince: at,
        notifiedLevel: null,
        notifiedAt: null,
      });
      return;
    }
    const levelSince =
      row.level === reading.level ? row.levelSince : new Date(Math.max(at.getTime(), row.since.getTime()));
    this.watched.set(reading.batchId, {
      ...row,
      nodeId: reading.nodeId,
      holder: reading.holder,
      level: reading.level,
      levelSince,
      message: reading.message,
    });
  }

  async remove(batchIds: readonly string[]): Promise<void> {
    for (const batchId of batchIds) this.watched.delete(batchId);
  }

  async setNotified(stamps: readonly { batchId: string; level: UnmarkedStampLevel }[], at: Date): Promise<void> {
    for (const stamp of stamps) {
      const row = this.watched.get(stamp.batchId);
      if (row) this.watched.set(stamp.batchId, { ...row, notifiedLevel: stamp.level, notifiedAt: at });
    }
  }
}

/** The moment the tests of the stamps not on auto top-up start at. */
export const WATCH_T0 = new Date('2026-11-24T12:00:00.000Z');

/** `seconds` after {@link WATCH_T0}. */
export function watchAt(seconds: number): Date {
  return new Date(WATCH_T0.getTime() + seconds * 1000);
}

/** The catalogue node's archive stamp, and a batch a node takes in place of its own. */
export const BATCH_ARCHIVE = `0x${'e4'.repeat(32)}`;
export const BATCH_NEW = `0x${'f5'.repeat(32)}`;

/**
 * What the inventory lists of each stamp: a batch read whole with 30 days left unless given, or null when its node
 * lists none (the stage's and the rung's) or the manager keeps no archive stamp. Every node's view of the chain is
 * current unless the stage's node says otherwise.
 */
export interface Shelf {
  catalogue?: Partial<FundingBatch>;
  archive?: Partial<FundingBatch> | null;
  stage?: Partial<FundingBatch> | null;
  rung?: Partial<FundingBatch> | null;
  stageNode?: Partial<FundingNode>;
}

/** An expired batch, as the inventory goes on listing one. */
export const EXPIRED: Partial<FundingBatch> = { state: 'expired', ttlSeconds: 0 };

/**
 * One stage with its own node, a gateway and a 720p rung, the catalogue node, and an archive stamp "Keynotes" on the
 * catalogue node, each batch as the shelf says.
 */
export function watchInventory(shelf: Shelf = {}): FundingInventory {
  const listed = (batchId: string, over: Partial<FundingBatch> | undefined) =>
    fundingBatch({ batchId, ttlSeconds: 30 * SECONDS_PER_DAY, ...over });
  const base = fundingInventory();
  return {
    ...base,
    stages: [
      {
        ...base.stages[0]!,
        nodes: [
          fundingNode({
            chainLagBlocks: 3,
            ...shelf.stageNode,
            batch: shelf.stage === null ? null : listed(BATCH_STAGE, shelf.stage),
          }),
          fundingNode({ nodeId: NODE_B, label: 'Main stage gateway', role: 'gateway', chainLagBlocks: 3, batch: null }),
          fundingNode({
            nodeId: NODE_RUNG,
            label: 'Main stage 720p rung',
            role: 'rung',
            chainLagBlocks: 3,
            batch: shelf.rung === null ? null : listed(BATCH_RUNG, shelf.rung),
          }),
        ],
      },
    ],
    catalogue: fundingNode({
      nodeId: NODE_CATALOGUE,
      label: 'Catalogue node',
      chainLagBlocks: 3,
      batch: listed(BATCH_CATALOGUE, shelf.catalogue),
    }),
    archiveBatches:
      shelf.archive === null
        ? []
        : [
            {
              ...listed(BATCH_ARCHIVE, shelf.archive),
              nodeId: NODE_CATALOGUE,
              nodeLabel: 'Catalogue node',
              label: 'Keynotes',
              writable: true,
            },
          ],
  };
}

/** A mark on a stamp, with no alert. */
export function markRowOf(batchId: string, nodeId: string): AutoTopUpMarkRow {
  return {
    batchId,
    nodeId,
    nodeLabel: 'A node',
    markedAt: WATCH_T0,
    markedBy: 'operator-a',
    alert: null,
    unreadSince: null,
  };
}

/** A tick at `now` over this inventory and these marks, with the default numbers and no brand wallet. */
export function watchContext(
  now: Date,
  listed: FundingInventory,
  marks: readonly AutoTopUpMarkRow[] = [],
): AutoTopUpTickContext {
  return {
    now,
    settings: AUTO_TOPUP_DEFAULTS,
    funding: { inventory: listed, postage: POSTAGE, brandWallet: null, pins: new Map() },
    stamps: markedStampsOf(listed, marks),
  };
}

/** What one person read: the notice written from the parts of the topics they ticked. */
export interface Read {
  person: number;
  notice: Notice;
  subjects: string[];
}

/**
 * A notifier with people, each ticking topics, with one destination each. While `failing` is set every destination
 * fails. While `secondFails` is set each person has a second destination that fails, so their notice waits for it. A
 * retry drops the waiting notices none of whose subjects stands, and keeps the rest waiting.
 */
export class PeopleNotifier implements Notifier {
  people: NoticeTopic[][] = [['unmarked_catalogue', 'unmarked_stage']];
  failing = false;
  secondFails = false;
  reads: Read[] = [];
  notifies = 0;
  waiting: { person: number; subjects: string[] }[] = [];

  async on(topic: NoticeTopic): Promise<boolean> {
    return this.people.some((topics) => topics.includes(topic));
  }

  async notify<T>(notice: OutgoingNotice<T>): Promise<NotifyOutcome> {
    this.notifies += 1;
    const taken = new Set<string>();
    let sent = 0;
    let failed = 0;
    this.people.forEach((topics, person) => {
      const mine = notice.parts.filter((part) => topics.includes(part.topic));
      if (mine.length === 0) return;
      const subjects = mine.map((part) => part.subject);
      if (this.failing) {
        failed += 1;
        return;
      }
      this.reads.push({ person, notice: notice.compose(mine), subjects });
      sent += 1;
      for (const subject of subjects) taken.add(subject);
      if (this.secondFails) {
        failed += 1;
        this.waiting.push({ person, subjects });
      }
    });
    return {
      parts: notice.parts.map((part) => ({
        subject: part.subject,
        people: this.people.filter((topics) => topics.includes(part.topic)).length,
        taken: taken.has(part.subject),
      })),
      sent,
      failed,
    };
  }

  async retryWaiting(_now: Date, stands: (subject: string) => boolean): Promise<RetryOutcome> {
    const before = this.waiting.length;
    this.waiting = this.waiting.filter((notice) => notice.subjects.some((subject) => stands(subject)));
    return { sent: 0, dropped: before - this.waiting.length, waiting: this.waiting.length };
  }
}
