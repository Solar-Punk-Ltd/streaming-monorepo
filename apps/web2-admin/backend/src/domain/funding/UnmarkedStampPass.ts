import {
  fundingNodeChainCurrent,
  type FundingBatch,
  type FundingInventory,
  type FundingNode,
} from '@streaming-monorepo/contracts';
import {
  AUTO_TOPUP_ONCE_PER_SECONDS,
  SECONDS_PER_DAY,
  UNMARKED_STAMP_HOLDERS,
  UNMARKED_STAMP_LAST_DAYS,
  operableBatch,
  unmarkedStampLevel,
  unmarkedStampTopic,
  type AutoTopUpSettings,
  type AutoTopUpUnmarkedView,
  type UnmarkedStampHolder,
  type UnmarkedStampLevel,
} from '@streaming-monorepo/web2-admin-common';

import type { Logger } from '../Logger.js';
import type { Notifier, OutgoingNotice } from '../notifications/Notifier.js';

import { unmarkedStampSubject, type UnmarkedStampRow, type UnmarkedStampStore } from './UnmarkedStampStore.js';
import type { AutoTopUpTickContext } from './autoTopUpJobs.js';
import type { StampName } from './autoTopUpTexts.js';
import {
  unmarkedStampExpiredText,
  unmarkedStampLowText,
  unmarkedStampUnlistedText,
  unmarkedStampsNotice,
  type UnmarkedNoticeItem,
} from './unmarkedStampTexts.js';

/**
 * The stamps not on auto top-up (docs/architecture/funding.md, "Stamps not on auto top-up"): the alert job's pass over
 * every stamp the Stamps tab lists without a mark, the catalogue batch, the archive stamps and each stage's batches.
 * The admin tops none of them up. Each run, after the alert job's own work, it:
 *
 * - lists a stamp read under "Top up when under" with time left, and words anew what the tab says of it;
 * - moves it to under 2 days, and to expired once it ran out or its node holds it no more; a stamp first read expired
 *   is not listed;
 * - takes off the list a stamp read at the threshold or above, and one that was marked;
 * - records a listed stamp the manager lists no more as expired, and takes an expired one off the list once the
 *   manager lists it no more and it has been expired for a day;
 * - leaves a stamp that could not be read where it stands for the run;
 * - tells of the stamps in one notice: each one that reached a level not told of yet, and once a day, when one was
 *   last told of a day ago, every other one still under the threshold as well. Each part goes under the topic of the
 *   stamp's holder, so each person reads the stamps of the topics they ticked.
 *
 * It raises no warning, never fails the alert job and moves no money. A notice no destination took goes again at the
 * next run; while nobody gets a topic, its stamps are told of to nobody and the Auto top-up tab alone lists them.
 */

/** One day, after which a listed stamp told of before is told of again in the day's notice. */
const REMINDER_MS = AUTO_TOPUP_ONCE_PER_SECONDS * 1000;
/** One day, which an expired stamp the manager lists no more stays listed from when it expired. */
const EXPIRED_KEPT_MS = SECONDS_PER_DAY * 1000;

/** The levels from the least worrying to the most: a notice tells of a level once, when a stamp reaches it. */
const LEVEL_RANK: Readonly<Record<UnmarkedStampLevel, number>> = { low: 0, last: 1, expired: 2 };

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? '' : 's'}`;
}

/** A stamp the Stamps tab lists without a mark, as one run's inventory lists it. */
export interface WatchedStamp {
  /** `0x` and 64 hex digits, lower case. */
  batchId: string;
  /** The node that holds it, by the manager's id. */
  nodeId: string;
  holder: UnmarkedStampHolder;
  /** Whether it is an archive stamp. */
  archive: boolean;
  name: StampName;
  /**
   * Its node among the stages' nodes and the catalogue node, whose view of the chain the inventory reports, or null
   * when the inventory lists none by that id: an archive stamp left on a node that is the catalogue node no longer.
   */
  node: FundingNode | null;
  batch: FundingBatch;
}

/** Each stage's nodes and the designated catalogue node. */
function fundedNodesOf(inventory: FundingInventory): FundingNode[] {
  return [...inventory.stages.flatMap((stage) => stage.nodes), ...(inventory.catalogue ? [inventory.catalogue] : [])];
}

/**
 * Every stamp the Stamps tab lists, less the marked ones, each once: the catalogue batch, the archive stamps and each
 * stage's batches, in that order. A batch listed twice is taken as first listed.
 */
export function unmarkedStampsOf(inventory: FundingInventory, marked: ReadonlySet<string>): WatchedStamp[] {
  const watched = new Map<string, WatchedStamp>();
  const add = (stamp: WatchedStamp) => {
    if (!marked.has(stamp.batchId) && !watched.has(stamp.batchId)) watched.set(stamp.batchId, stamp);
  };
  const catalogue = inventory.catalogue;
  if (catalogue?.batch) {
    const batchId = catalogue.batch.batchId.toLowerCase();
    add({
      batchId,
      nodeId: catalogue.nodeId,
      holder: 'catalogue',
      archive: false,
      name: { batchId, title: 'The catalogue batch', nodeLabel: catalogue.label },
      node: catalogue,
      batch: catalogue.batch,
    });
  }
  const funded = fundedNodesOf(inventory);
  for (const archive of inventory.archiveBatches ?? []) {
    const batchId = archive.batchId.toLowerCase();
    add({
      batchId,
      nodeId: archive.nodeId,
      holder: 'catalogue',
      archive: true,
      name: {
        batchId,
        title: archive.label ? `Archive stamp "${archive.label}"` : 'An archive stamp',
        nodeLabel: archive.nodeLabel,
      },
      node: funded.find((node) => node.nodeId === archive.nodeId) ?? null,
      batch: archive,
    });
  }
  for (const stage of inventory.stages) {
    for (const node of stage.nodes) {
      if (!node.batch) continue;
      const batchId = node.batch.batchId.toLowerCase();
      add({
        batchId,
        nodeId: node.nodeId,
        holder: 'stage',
        archive: false,
        name: { batchId, title: `The batch of stage "${stage.name}"`, nodeLabel: node.label },
        node,
        batch: node.batch,
      });
    }
  }
  return [...watched.values()];
}

/**
 * What one run reads of an unmarked stamp, as the alert job reads a marked one: `expired` once it ran out or its node
 * holds it no more; `unread` while its node or its batch could not be read, the node's view of the chain is not known
 * to be current, or the batch is not usable; and otherwise its time left with its level, null at the threshold or
 * above.
 */
export type WatchReading =
  | { state: 'expired' }
  | { state: 'unread' }
  | { state: 'read'; ttlSeconds: number; level: Exclude<UnmarkedStampLevel, 'expired'> | null };

export function watchReadingOf(stamp: WatchedStamp, settings: Pick<AutoTopUpSettings, 'topUpUnderDays'>): WatchReading {
  const { batch, node } = stamp;
  if (batch.state === 'expired' || batch.state === 'gone' || batch.ttlSeconds === 0) return { state: 'expired' };
  if (node === null || node.readError !== null || fundingNodeChainCurrent(node) !== true || !operableBatch(batch)) {
    return { state: 'unread' };
  }
  return { state: 'read', ttlSeconds: batch.ttlSeconds, level: unmarkedStampLevel(batch.ttlSeconds, settings) };
}

/**
 * A listed stamp the manager lists no more, named from what the inventory still lists: its node's stage, and its
 * node's label.
 */
function unlistedNameOf(row: UnmarkedStampRow, inventory: FundingInventory): StampName {
  const node = fundedNodesOf(inventory).find((candidate) => candidate.nodeId === row.nodeId);
  const stage = inventory.stages.find((candidate) => candidate.nodes.some((one) => one.nodeId === row.nodeId));
  const title =
    row.holder === 'stage'
      ? stage
        ? `A batch of stage "${stage.name}"`
        : "A stage's batch"
      : 'The catalogue batch or an archive stamp';
  return { batchId: row.batchId, title, nodeLabel: node?.label ?? 'a node the manager lists no more' };
}

/**
 * The least time left first: expired, then under 2 days, then under the threshold, each the earliest under it first.
 * At a steady price a stamp's time left falls a second a second, so within a level the earliest is the lowest.
 */
export function byLeastTimeLeft(a: UnmarkedStampRow, b: UnmarkedStampRow): number {
  return (
    LEVEL_RANK[b.level] - LEVEL_RANK[a.level] ||
    a.since.getTime() - b.since.getTime() ||
    (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0)
  );
}

/**
 * The least time left first as one run read it: by level, then by the time left the run read, and by
 * {@link byLeastTimeLeft} for a stamp it did not read.
 */
function byTimeLeftRead(ttls: ReadonlyMap<string, number>): (a: UnmarkedStampRow, b: UnmarkedStampRow) => number {
  return (a, b) => {
    const rank = LEVEL_RANK[b.level] - LEVEL_RANK[a.level];
    if (rank !== 0) return rank;
    const left = ttls.get(a.batchId);
    const right = ttls.get(b.batchId);
    if (left !== undefined && right !== undefined && left !== right) return left - right;
    return byLeastTimeLeft(a, b);
  };
}

/** `GET /api/funding/auto-top-up/unmarked`: the listed stamps, the least time left first. */
export function unmarkedStampsView(rows: readonly UnmarkedStampRow[]): AutoTopUpUnmarkedView {
  return {
    stamps: [...rows].sort(byLeastTimeLeft).map((row) => ({
      batchId: row.batchId,
      nodeId: row.nodeId,
      holder: row.holder,
      level: row.level,
      since: row.since.toISOString(),
      levelSince: row.levelSince.toISOString(),
      message: row.message,
      notifiedAt: row.notifiedAt?.toISOString() ?? null,
    })),
  };
}

/** Whether a listed stamp reached a level no notice told of yet. A level that drops back is not told of again. */
function reachedNewLevel(row: UnmarkedStampRow): boolean {
  return row.notifiedLevel === null || LEVEL_RANK[row.level] > LEVEL_RANK[row.notifiedLevel];
}

/** The level a taken notice records for a stamp: the higher of its level and the one told of before, so it stays. */
function toldLevel(row: UnmarkedStampRow): UnmarkedStampLevel {
  return row.notifiedLevel !== null && LEVEL_RANK[row.notifiedLevel] > LEVEL_RANK[row.level]
    ? row.notifiedLevel
    : row.level;
}

/** What the listed stamps come to, by level, in the words of a run's outcome. */
function listedText(rows: readonly UnmarkedStampRow[]): string {
  const count = (level: UnmarkedStampLevel) => rows.filter((row) => row.level === level).length;
  const parts = [
    ...(count('low') > 0 ? [`${count('low')} under "Top up when under"`] : []),
    ...(count('last') > 0 ? [`${count('last')} under ${plural(UNMARKED_STAMP_LAST_DAYS, 'day')}`] : []),
    ...(count('expired') > 0 ? [`${count('expired')} expired`] : []),
  ];
  return `Stamps not on auto top-up: ${parts.join(', ')}`;
}

export interface UnmarkedStampPassDeps {
  store: UnmarkedStampStore;
  logger: Pick<Logger, 'info' | 'warn'>;
}

export class UnmarkedStampPass {
  private readonly store: UnmarkedStampStore;
  private readonly logger: Pick<Logger, 'info' | 'warn'>;

  constructor(deps: UnmarkedStampPassDeps) {
    this.store = deps.store;
    this.logger = deps.logger;
  }

  /**
   * The subjects of the listed stamps' notices, an expired one's included: a notice that waits for a destination
   * stands while one of the stamps it tells of is listed.
   */
  async standingSubjects(): Promise<string[]> {
    return (await this.store.rows()).map((row) => unmarkedStampSubject(row.batchId));
  }

  /**
   * One run, in the alert job's run after its own work, through the alert job's notifier. Answers a sentence for the
   * job's outcome, or null with no stamp listed. It never throws: a failure is logged and said in that sentence.
   */
  async run(context: AutoTopUpTickContext, notifier: Notifier): Promise<string | null> {
    try {
      const { rows, ttls } = await this.reckon(context);
      return await this.tell(context.now, rows, ttls, notifier);
    } catch (error) {
      this.logger.warn(
        `[AutoTopUp] the stamps not on auto top-up could not be read in this run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 'The stamps not on auto top-up could not be read in this run. The log says why.';
    }
  }

  /**
   * Writes what this run read of the unmarked stamps. Answers the listed ones after it, and the time left it read of
   * each stamp it listed under the threshold.
   */
  private async reckon(
    context: AutoTopUpTickContext,
  ): Promise<{ rows: UnmarkedStampRow[]; ttls: Map<string, number> }> {
    const { now, settings } = context;
    const { inventory } = context.funding;
    const marked = new Set(context.stamps.map((stamp) => stamp.mark.batchId.toLowerCase()));
    const watched = unmarkedStampsOf(inventory, marked);
    const rows = new Map((await this.store.rows()).map((row) => [row.batchId, row]));
    const ttls = new Map<string, number>();
    const off: string[] = [];

    for (const stamp of watched) {
      const row = rows.get(stamp.batchId);
      const reading = watchReadingOf(stamp, settings);
      const base = { batchId: stamp.batchId, nodeId: stamp.nodeId, holder: stamp.holder };
      if (reading.state === 'unread') continue;
      if (reading.state === 'expired') {
        if (row !== undefined && row.level !== 'expired') {
          const message = unmarkedStampExpiredText({ stamp: stamp.name, archive: stamp.archive });
          await this.store.record({ ...base, level: 'expired', message }, now);
        }
        continue;
      }
      if (reading.level === null) {
        if (row !== undefined) off.push(stamp.batchId);
        continue;
      }
      const message = unmarkedStampLowText({
        stamp: stamp.name,
        level: reading.level,
        ttlSeconds: reading.ttlSeconds,
        topUpUnderDays: settings.topUpUnderDays,
      });
      await this.store.record({ ...base, level: reading.level, message }, now);
      ttls.set(stamp.batchId, reading.ttlSeconds);
    }

    const listed = new Set(watched.map((stamp) => stamp.batchId));
    for (const row of rows.values()) {
      if (listed.has(row.batchId)) continue;
      if (marked.has(row.batchId)) {
        off.push(row.batchId);
      } else if (row.level !== 'expired') {
        const message = unmarkedStampUnlistedText(unlistedNameOf(row, inventory));
        const { batchId, nodeId, holder } = row;
        await this.store.record({ batchId, nodeId, holder, level: 'expired', message }, now);
      } else if (now.getTime() - row.levelSince.getTime() >= EXPIRED_KEPT_MS) {
        off.push(row.batchId);
      }
    }
    await this.store.remove(off);
    return { rows: await this.store.rows(), ttls };
  }

  /**
   * Sends the run's notice, when there is one to send: every listed stamp whose topic someone gets and that reached a
   * level no notice told of, and, once one told of before was last told of a day ago, every other one still under
   * the threshold. A stamp is told of once a destination took a notice that held it. Answers the run's sentence.
   */
  private async tell(
    now: Date,
    rows: readonly UnmarkedStampRow[],
    ttls: ReadonlyMap<string, number>,
    notifier: Notifier,
  ): Promise<string | null> {
    if (rows.length === 0) return null;
    const listed = listedText(rows);
    const on = new Map<UnmarkedStampHolder, boolean>();
    for (const holder of UNMARKED_STAMP_HOLDERS) on.set(holder, await notifier.on(unmarkedStampTopic(holder)));
    if (![...on.values()].some((gets) => gets)) {
      return `${listed}. Nobody gets their notices, so the Auto top-up tab alone lists them.`;
    }

    const told = rows.filter((row) => on.get(row.holder) === true).sort(byTimeLeftRead(ttls));
    const fresh = told.filter(reachedNewLevel);
    const freshIds = new Set(fresh.map((row) => row.batchId));
    const still = told.filter((row) => row.level !== 'expired' && !freshIds.has(row.batchId));
    const reminderDue = still.some(
      (row) => row.notifiedAt !== null && now.getTime() - row.notifiedAt.getTime() >= REMINDER_MS,
    );
    const parts = [...fresh, ...(reminderDue ? still : [])];
    if (parts.length === 0) return `${listed}.`;

    const outgoing: OutgoingNotice<UnmarkedNoticeItem> = {
      raisedAt: now,
      parts: parts.map((row) => ({
        topic: unmarkedStampTopic(row.holder),
        subject: unmarkedStampSubject(row.batchId),
        item: { level: row.level, fresh: freshIds.has(row.batchId), message: row.message },
      })),
      compose: (chosen) => unmarkedStampsNotice(chosen.map((part) => part.item)),
    };
    const outcome = await notifier.notify(outgoing);
    const taken = parts.filter((_, index) => outcome.parts[index]?.taken === true);
    await this.store.setNotified(
      taken.map((row) => ({ batchId: row.batchId, level: toldLevel(row) })),
      now,
    );
    if (taken.length > 0) return `${listed}. Told of ${plural(taken.length, 'stamp')} in a notice.`;
    const title = outgoing.compose(outgoing.parts).title;
    const why = outcome.failed === 0 ? 'nobody gets it' : `${plural(outcome.failed, 'destination')} could not take it`;
    this.logger.warn(`[AutoTopUp] no destination took the notice "${title}": ${why}.`);
    return `${listed}. No destination took their notice, since ${why}: it goes again at the next run.`;
  }
}
