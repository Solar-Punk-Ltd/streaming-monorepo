import type { CatalogueStampRecord } from '@streaming-monorepo/contracts';
import type {
  CatalogueBatchReading,
  CatalogueWriteProblem,
  CatalogueWriteStatus,
} from '@streaming-monorepo/web2-admin-common';

import { isDesignated, type CatalogueStampRow } from '../types/index.js';
import { quoteForLog } from '../utils/logText.js';

import { describeActor, type Actor } from './actor.js';
import { recordAudit, type AuditLog } from './AuditLog.js';
import { CatalogueStampUnavailableError } from './errors/index.js';
import type { CatalogueTarget } from './FeedGateway.js';
import type { FeedIdentity } from './feedIdentity.js';
import { Logger } from './Logger.js';

const logger = Logger.getInstance();

/** `ab12cd34…`: enough of a batch id to recognise it in a sentence or a log. */
export function shortBatch(batchId: string): string {
  return `${batchId.slice(0, 8)}…`;
}

/**
 * The sentence the admin refuses a catalogue write with. The console shows it as it is, on My Streams and in the
 * answer to the refused call, so it says why and what ends it.
 */
export function catalogueRefusal(problem: CatalogueWriteProblem, batchId: string | null): string {
  switch (problem) {
    case 'none':
      return 'The manager has not designated a catalogue batch yet. Nothing is written to the catalogue until it does.';
    case 'cleared':
      return 'The manager cleared the catalogue batch designation. Nothing is written to the catalogue until it designates one again.';
    case 'expired':
    case 'gone':
      return `The catalogue batch ${batchId ? shortBatch(batchId) : ''} is ${problem}. Nothing can be written to the catalogue with it.`;
    case 'mutable':
      return `The catalogue batch ${batchId ? shortBatch(batchId) : ''} is mutable, and a mutable batch overwrites the catalogue's oldest slots once it fills. Nothing is written to the catalogue with it.`;
  }
}

/**
 * Whether a batch has run out by the time to live the manager last read for it: `observedAt` plus `ttlSeconds` is
 * before `now`, whatever `state` says. Only for a positive time to live; Bee reports a negative one when it cannot
 * tell. This compares the manager's moment with the admin's clock, which nothing else here does: a time to live is
 * measured in hours and days, so two hosts' clocks a few seconds apart cannot change the answer. It matters most for
 * a pinned batch the manager no longer reads, whose last reading only ages.
 */
export function expiredByClock(record: CatalogueStampRecord, now: number): boolean {
  if (record.ttlSeconds === null || !(record.ttlSeconds > 0)) return false;
  const observed = Date.parse(record.observedAt);
  return Number.isFinite(observed) && observed + record.ttlSeconds * 1000 < now;
}

/** Why a write with this record is refused, or null when it can go. */
function refusalFor(record: CatalogueStampRecord, now: number): CatalogueWriteProblem | null {
  if (record.state === 'expired' || record.state === 'gone') return record.state;
  if (expiredByClock(record, now)) return 'expired';
  // The manager refuses to designate a mutable batch; this holds the rule on the admin's side as well.
  if (!record.immutable) return 'mutable';
  return null;
}

/**
 * What the next catalogue write would do, worked out from the catalogue stamp row and whether this feed has any write
 * recorded in `feed_writes`.
 *
 * The admin writes with the batch it pinned (`active_batch_id`), because a batch stamps the chunks it wrote and the
 * feed's history is those chunks. The rules:
 *
 * - No designation, or a cleared one: refuse. The pinned batch stays pinned, so a designation that comes back finds
 *   the history where it was.
 * - Nothing pinned yet: write with the designated batch, and pin it. That is also the first write after an upgrade
 *   from the env file's batch, whose history the admin never recorded a batch for; those rows keep a null `batch_id`
 *   and the move stamps them again.
 * - The designated batch is the pinned one: write with it, with the manager's latest readings and node address.
 * - The manager designated another batch and the feed has history: keep writing with the pinned one, as the manager
 *   last read it, and say a move to the designated one is waiting.
 * - The manager designated another batch and the feed has no history (the feed key changed): there is nothing to
 *   move, so pin the designated one.
 * - The batch it would write with is expired or gone, by the last reading the admin holds or by the time to live that
 *   reading gave it (`expiredByClock`), or it is mutable: refuse.
 *
 * The pinned batch's readings, once the manager designates another, are the last ones it pushed while that batch was
 * the designated one. They are kept and shown with the moment they were read, rather than treated as unknown: they
 * are the best the admin has, and an expired or gone among them is a refusal worth making before the node refuses.
 * They only age, so a waiting move is itself a warning.
 */
export interface CatalogueWritePlan {
  /** The record whose node and batch a write goes through, or null when nothing is designated. */
  batch: CatalogueStampRecord | null;
  /** Why the write is refused, or null when it can go. */
  refusal: { problem: CatalogueWriteProblem; message: string } | null;
  /** The designated batch a move waits for, or null when the catalogue is written with the designated one. */
  moveWaitingTo: string | null;
  /** Whether a write pins `batch` first. */
  pin: boolean;
  /** The batch pinned now, before any pin this plan makes. */
  pinned: string | null;
  /** Whether this feed has a write recorded in `feed_writes`. */
  hasHistory: boolean;
}

function refusal(problem: CatalogueWriteProblem, batchId: string | null): CatalogueWritePlan['refusal'] {
  return { problem, message: catalogueRefusal(problem, batchId) };
}

export function planCatalogueWrite(
  row: CatalogueStampRow | null,
  hasHistory: boolean,
  now: number = Date.now(),
): CatalogueWritePlan {
  const pinned = row?.active_batch_id ?? null;
  if (!isDesignated(row)) {
    // A row a clear made before any record arrived never designated anything here.
    const problem: CatalogueWriteProblem = row?.record ? 'cleared' : 'none';
    return { batch: null, refusal: refusal(problem, null), moveWaitingTo: null, pin: false, pinned, hasHistory };
  }

  const designated = row.record;
  const active = row.active_record;
  const keepsActive = active !== null && active.batchId !== designated.batchId && hasHistory;
  const batch = keepsActive ? active : designated;
  const moveWaitingTo = keepsActive ? designated.batchId : null;

  const problem = refusalFor(batch, now);
  if (problem) {
    return { batch, refusal: refusal(problem, batch.batchId), moveWaitingTo, pin: false, pinned, hasHistory };
  }
  return { batch, refusal: null, moveWaitingTo, pin: pinned !== batch.batchId, pinned, hasHistory };
}

/** The record as the console reads it. A batch refused as expired reads as expired, whatever its last state said. */
function readingOf(record: CatalogueStampRecord, refused: CatalogueWriteProblem | null): CatalogueBatchReading {
  return {
    batchId: record.batchId,
    nodeName: record.nodeName,
    state: refused === 'expired' ? 'expired' : record.state,
    ttlSeconds: record.ttlSeconds,
    fillRatio: record.fillRatio,
    observedAt: record.observedAt,
  };
}

function targetOf(record: CatalogueStampRecord): CatalogueTarget {
  return { beeApiUrl: record.beeApiUrl, batchId: record.batchId };
}

/** The slice of CatalogueStampRepository this service needs; a fake stands in. */
export interface CatalogueBatchStore {
  get(): Promise<CatalogueStampRow | null>;
  pin(record: CatalogueStampRecord): Promise<boolean>;
}

/** Whether a feed has history, and how much of it no recorded batch stamped: the slice of the feed write log read here. */
export interface FeedHistory {
  lastWrite(owner: string, topic: string): Promise<unknown>;
  countUnrecordedBatch(owner: string, topic: string): Promise<number>;
}

export interface CatalogueBatchOptions {
  /**
   * Whether a write needs a catalogue stamp at all. True for the Bee gateway. False for FEED_GATEWAY=fake, which
   * writes nowhere: with no designation stored it is handed no target and writes anyway, so local runs and the tests
   * need no manager. A stored designation is followed in both, expired and gone included.
   */
  stampRequired: boolean;
  /** The admin's clock, for `expiredByClock`; a test sets it. */
  now?: () => number;
}

/**
 * Where the catalogue is written: the node and batch of the catalogue stamp the manager pushed, read from the admin's
 * database on every write and never from the env file. `planCatalogueWrite` holds the rules; this reads what they need
 * and stores the pin they decide on.
 */
export class CatalogueBatchService {
  constructor(
    private readonly store: CatalogueBatchStore,
    private readonly history: FeedHistory,
    private readonly feed: FeedIdentity,
    private readonly audit: AuditLog,
    private readonly options: CatalogueBatchOptions,
  ) {}

  async plan(): Promise<CatalogueWritePlan> {
    const [row, last] = await Promise.all([
      this.store.get(),
      this.history.lastWrite(this.feed.owner, this.feed.topicHex),
    ]);
    return planCatalogueWrite(row, last !== null, (this.options.now ?? Date.now)());
  }

  /**
   * What the console is told: the batch the catalogue is written with, why it is refused, a waiting move, and the
   * writes stamped by a batch the admin never recorded. Those are counted for as long as any is left, pinned batch or
   * not: the batch that stamped them is unknown, so it cannot be told apart from the pinned one. The in-memory gateway
   * counts none, since its writes stamp nothing.
   */
  async status(): Promise<CatalogueWriteStatus> {
    const [plan, unrecorded] = await Promise.all([
      this.plan(),
      this.options.stampRequired ? this.history.countUnrecordedBatch(this.feed.owner, this.feed.topicHex) : 0,
    ]);
    return {
      batch: plan.batch ? readingOf(plan.batch, plan.refusal?.problem ?? null) : null,
      refusal: this.writesUnstamped(plan) ? null : plan.refusal,
      moveWaitingTo: plan.moveWaitingTo,
      unrecordedHistory: unrecorded > 0 ? { writes: unrecorded } : null,
    };
  }

  /**
   * The node and batch the next write goes through: the feed write and every thumbnail it uploads. Pins the batch
   * first when the plan says so, before anything is stamped with it, so a process that stops after the upload still
   * finds the batch its chunks are under. A pin followed by a write that fails leaves a pinned batch with no history,
   * which the next plan replaces freely. Throws CatalogueStampUnavailableError when the write is refused, and answers
   * null only to the in-memory gateway writing with no stamp.
   *
   * Called under the publish mutex, so two writes of this process never plan at once.
   */
  async forWrite(actor: Actor): Promise<CatalogueTarget | null> {
    const plan = await this.plan();
    if (this.writesUnstamped(plan)) return null;
    if (plan.refusal) throw new CatalogueStampUnavailableError(plan.refusal.problem, plan.refusal.message);
    const batch = plan.batch!;
    if (plan.pin) await this.pin(actor, batch, plan);
    return targetOf(batch);
  }

  /**
   * The node the boot check reads the feed head through: the one the catalogue is written with, even when its batch
   * is expired or gone, since reading stamps nothing. `skipped` holds the reason when there is none to read through;
   * the check then waits for a designation.
   */
  async forRead(): Promise<{ target: CatalogueTarget | null } | { skipped: string }> {
    const plan = await this.plan();
    if (this.writesUnstamped(plan)) return { target: null };
    if (!plan.batch) return { skipped: plan.refusal?.message ?? catalogueRefusal('none', null) };
    return { target: targetOf(plan.batch) };
  }

  private writesUnstamped(plan: CatalogueWritePlan): boolean {
    return !this.options.stampRequired && plan.batch === null;
  }

  private async pin(actor: Actor, batch: CatalogueStampRecord, plan: CatalogueWritePlan): Promise<void> {
    if (!(await this.store.pin(batch))) return;

    const where = `batch ${shortBatch(batch.batchId)} on ${quoteForLog(batch.nodeName)}`;
    const who = describeActor(actor);
    if (plan.pinned !== null) {
      logger.info(
        `[Catalogue] ${who}'s write pinned ${where} in place of ${shortBatch(plan.pinned)}, which stamped no write of this feed`,
      );
    } else if (plan.hasHistory) {
      logger.warn(
        `[Catalogue] ${who}'s write pinned ${where}. The feed's earlier writes were stamped by a batch this admin did not record (the env file's, before the catalogue stamp): they stay stamped by it until the catalogue is moved to this one`,
      );
    } else {
      logger.info(`[Catalogue] ${who}'s write pinned ${where}: the catalogue is written with it from now on`);
    }
    await recordAudit(this.audit, {
      actor,
      action: 'catalogue.batch.pin',
      details: {
        batchId: batch.batchId,
        nodeName: batch.nodeName,
        previousBatchId: plan.pinned,
        feedHadHistory: plan.hasHistory,
      },
    });
  }
}
