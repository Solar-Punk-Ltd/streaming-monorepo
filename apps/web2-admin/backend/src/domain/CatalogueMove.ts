import type { CatalogueStampRecord } from '@streaming-monorepo/contracts';
import type {
  CatalogueMoveProblem,
  CatalogueMoveStatus,
  CatalogueMoveSummary,
} from '@streaming-monorepo/web2-admin-common';

import { isDesignated, type CatalogueStampRow } from '../types/index.js';
import { getErrorMessage } from '../utils/errorUtils.js';

import { describeActor, type Actor } from './actor.js';
import { recordAudit, type AuditLog } from './AuditLog.js';
import { catalogueRefusal, refusalFor, shortBatch, type CatalogueBatchStore } from './CatalogueBatch.js';
import type { CatalogueMoveRow, CatalogueMoveStore, FeedSlotRow } from './CatalogueMoveRepository.js';
import { withoutCatalogueNode } from './catalogueNodeText.js';
import { CatalogueMoveRefusedError } from './errors/index.js';
import type { CatalogueRestamper, CatalogueTarget, ThumbnailFile } from './FeedGateway.js';
import type { FeedIdentity } from './feedIdentity.js';
import { Logger } from './Logger.js';
import type { Mutex } from './Mutex.js';
import { THUMBNAIL_FILE_EXTENSIONS } from './PublishService.js';
import { expiredByClock } from './stampAge.js';
import type { StoredThumbnail } from './StreamRepository.js';

const logger = Logger.getInstance();

/**
 * How many slots are uploaded again between two looks at the designation, outside the publish mutex, and how many
 * may be left for the last step, under it. Publishing waits for that last step, so it is kept short.
 */
export const MOVE_SLICE_SLOTS = 20;

/** The sentence a move is refused with, which the console shows as it is. */
export function catalogueMoveRefusal(
  problem: CatalogueMoveProblem,
  detail: { targetBatchId?: string | null; fromBatchId?: string | null; lacking?: number } = {},
): string {
  const target = detail.targetBatchId ? shortBatch(detail.targetBatchId) : '';
  switch (problem) {
    case 'disabled':
      return 'Moving the catalogue to another batch is not yet enabled on this installation. It is turned on with CATALOGUE_MOVE_ENABLED once the move has been tried on a real node.';
    case 'none':
      return 'The manager has not designated a catalogue batch, so there is no batch to move the catalogue to.';
    case 'cleared':
      return 'The manager cleared the catalogue batch designation, so there is no batch to move the catalogue to.';
    case 'nothing':
      return `Every slot of the catalogue is already under batch ${target}. There is nothing to move.`;
    case 'target':
      return `The batch to move to, ${target}, cannot be written with, so the catalogue cannot move to it.`;
    case 'lapsed': {
      const from = detail.fromBatchId ? shortBatch(detail.fromBatchId) : '';
      const slots = detail.lacking === 1 ? '1 slot has' : `${detail.lacking ?? 0} slots have`;
      return `The batch the catalogue is written with, ${from}, has lapsed, and ${slots} no recorded bytes to upload again: they were written before the admin kept them, and the network no longer holds a chunk whose batch has lapsed. The move cannot bring them back.`;
    }
    case 'changed':
      return `The manager designates another batch than ${target} now. Reload the page and start the move to the batch it names.`;
  }
}

/** What `planCatalogueMove` reads. */
export interface CatalogueMoveInput {
  enabled: boolean;
  row: CatalogueStampRow | null;
  /** The feed's last slot by `feed_writes`, or null when it has none. */
  head: number | null;
  /** Slots from 0 to the head that are not under the designated batch by the admin's record. */
  toRestamp: number;
  /** Of those, the slots with no recorded bytes, which only the network can give. */
  lacking: number;
  /**
   * Whether the latest move to the designated batch is running or failed: it has not switched, and its thumbnails or
   * its switch may be all that is left, with every slot already under the batch.
   */
  unfinished: boolean;
  now: number;
}

export interface CatalogueMovePlan {
  waiting: CatalogueMoveStatus['waiting'];
  refusal: CatalogueMoveStatus['refusal'];
  /** The designated record the move stamps under, or null when there is none. */
  target: CatalogueStampRecord | null;
}

/**
 * Whether a move of the catalogue's history waits, and why it cannot start now.
 *
 * A move waits when the feed has history and any of these holds: the pinned batch is not the designated one (the
 * manager designated another, or moved back to one whose slots are all still under it, which needs the switch
 * alone); some slot from 0 to the head is not under the designated batch by the admin's record (written with
 * another batch, or with one the admin never recorded, the env file's); or the latest move to it has not finished.
 * Nothing waits only when the pinned batch is the designated one and every slot is under it. Otherwise the viewer
 * loses every entry after the first slot whose batch lapses.
 *
 * It cannot start while the move is not enabled, when the designated batch cannot be written with (expired, gone or
 * mutable, as `refusalFor` says for a write), or when the batch the catalogue is written with has lapsed while some
 * slot has no recorded bytes: those can only be read from the network, which drops a chunk once its batch lapses.
 * The batch of a slot written before the catalogue stamp is unknown, so only the pinned one is checked; a slot that
 * cannot be read stops the move with its reason.
 */
export function planCatalogueMove(input: CatalogueMoveInput): CatalogueMovePlan {
  const { row } = input;
  if (!isDesignated(row)) {
    const problem: CatalogueMoveProblem = row?.record ? 'cleared' : 'none';
    return { waiting: null, refusal: { problem, message: catalogueMoveRefusal(problem) }, target: null };
  }

  const target = row.record;
  const pinnedIsTarget = row.active_batch_id === target.batchId;
  if (input.head === null || (input.toRestamp <= 0 && pinnedIsTarget && !input.unfinished)) {
    const refusal = {
      problem: 'nothing' as const,
      message: catalogueMoveRefusal('nothing', { targetBatchId: target.batchId }),
    };
    return { waiting: null, refusal, target };
  }

  const from = row.active_record;
  const waiting = { targetBatchId: target.batchId, fromBatchId: row.active_batch_id, slots: input.head + 1 };
  const refuse = (problem: CatalogueMoveProblem, message: string): CatalogueMovePlan => ({
    waiting,
    refusal: { problem, message },
    target,
  });

  if (!input.enabled) return refuse('disabled', catalogueMoveRefusal('disabled'));
  const targetProblem = refusalFor(target, input.now);
  if (targetProblem) {
    return refuse(
      'target',
      `${catalogueMoveRefusal('target', { targetBatchId: target.batchId })} ${catalogueRefusal(targetProblem, target.batchId)}`,
    );
  }
  if (from && from.batchId !== target.batchId && input.lacking > 0 && lapsed(from, input.now)) {
    return refuse('lapsed', catalogueMoveRefusal('lapsed', { fromBatchId: from.batchId, lacking: input.lacking }));
  }
  return { waiting, refusal: null, target };
}

function lapsed(record: CatalogueStampRecord, now: number): boolean {
  return record.state === 'expired' || record.state === 'gone' || expiredByClock(record, now);
}

function summaryOf(move: CatalogueMoveRow | null): CatalogueMoveSummary | null {
  if (!move) return null;
  return {
    id: move.id,
    state: move.state,
    targetBatchId: move.targetBatchId,
    fromBatchId: move.fromBatchId,
    slotsDone: move.nextIndex,
    slotsTotal: move.headIndex === null ? null : move.headIndex + 1,
    restamped: move.restampedSlots,
    skipped: move.skippedSlots,
    thumbnails: move.thumbnails,
    error: move.error,
    startedBy: move.startedBy,
    startedAt: move.startedAt.toISOString(),
    finishedAt: move.finishedAt?.toISOString() ?? null,
  };
}

/** The slice of the feed write log the move reads: the head, and the entries written there. */
export interface MoveFeedHistory {
  lastWrite(owner: string, topic: string): Promise<{ index: number; entries: unknown[] } | null>;
}

/**
 * Where the move finds every thumbnail a stream names, with its stored bytes, and records the batch each is under once
 * it was uploaded again: StreamRepository.
 */
export interface MoveThumbnailStore {
  listStoredThumbnails(): Promise<StoredThumbnail[]>;
  recordThumbnailBatch(reference: string, batchId: string): Promise<void>;
}

export interface CatalogueMoveOptions {
  /** `CATALOGUE_MOVE_ENABLED`. Off by default: the move has to be tried on a real node first. */
  enabled: boolean;
  now?: () => number;
  sliceSlots?: number;
}

/** Why the job stops before it has finished, in the sentence the console shows. */
class MoveStopped extends Error {}

/** The process is shutting down: the move stays running, and the next start resumes it where it stopped. */
class MovePaused extends Error {}

/** A reference an entry names as its thumbnail: 64 hex digits, or 128 for an encrypted one. */
const REFERENCE_RE = /^[0-9a-f]{64}([0-9a-f]{64})?$/i;

/**
 * Moving the catalogue's history onto another batch: every slot of the feed, from 0 to its head, uploaded again under
 * the batch the manager designated, byte for byte, then every thumbnail a stream or the latest entry names, then the
 * admin writes with the new batch. `docs/architecture/stages.md`, "Moving the catalogue to another batch", is the design.
 *
 * The job does not hold the publish mutex while it goes through the history, so publishing carries on, writing with
 * the pinned batch. It takes the mutex only for the last step: the slots written meanwhile, the thumbnails of the
 * entry written last, and the switch to the new batch, in one go, so no slot is ever left under the old batch alone.
 *
 * Progress is in `catalogue_moves` after every slot, so a restart continues where it stopped, and a failure keeps its
 * reason and can be retried. Started by an operator from the Stages page, and only while `CATALOGUE_MOVE_ENABLED` is
 * on.
 */
export class CatalogueMoveService {
  private job: Promise<void> | null = null;
  private stopping = false;
  private readonly now: () => number;
  private readonly sliceSlots: number;

  constructor(
    private readonly store: CatalogueMoveStore,
    private readonly stamps: CatalogueBatchStore,
    private readonly history: MoveFeedHistory,
    private readonly thumbnails: MoveThumbnailStore,
    private readonly gateway: CatalogueRestamper,
    /** The publish mutex, shared with PublishService: the last step holds it. */
    private readonly mutex: Mutex,
    private readonly feed: FeedIdentity,
    private readonly audit: AuditLog,
    private readonly options: CatalogueMoveOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.sliceSlots = Math.max(1, options.sliceSlots ?? MOVE_SLICE_SLOTS);
  }

  async status(): Promise<CatalogueMoveStatus> {
    const { plan, latest, row } = await this.evaluate();
    return {
      enabled: this.options.enabled,
      waiting: plan.waiting,
      refusal: plan.waiting ? plan.refusal : null,
      latest: summaryOf(latest),
      designatedBatchId: isDesignated(row) ? row.record.batchId : null,
      pinnedBatchId: row?.active_batch_id ?? null,
    };
  }

  /**
   * Starts the move to `targetBatchId`, which must be the designated batch the page showed, or retries a failed move
   * to it from where it stopped. A move already running answers its status. Refused, with the sentence the console
   * shows, for every reason `planCatalogueMove` gives.
   */
  async start(actor: Actor, targetBatchId: string): Promise<CatalogueMoveStatus> {
    // First, before a running move is resumed: nothing moves while the move is off.
    if (!this.options.enabled) throw new CatalogueMoveRefusedError('disabled', catalogueMoveRefusal('disabled'));
    const { plan, latest, head } = await this.evaluate();
    if (latest?.state === 'running' && latest.targetBatchId === targetBatchId) {
      // Running here, or left running by a process that stopped and has not resumed it: go on with it.
      if (!this.job) this.launch(latest, actor);
      return this.status();
    }
    if (!plan.waiting || plan.refusal) {
      const refusal = plan.refusal ?? { problem: 'nothing' as const, message: catalogueMoveRefusal('nothing') };
      throw new CatalogueMoveRefusedError(refusal.problem, refusal.message);
    }
    if (plan.waiting.targetBatchId !== targetBatchId.toLowerCase()) {
      throw new CatalogueMoveRefusedError('changed', catalogueMoveRefusal('changed', { targetBatchId }));
    }

    const retrying = latest?.state === 'failed' && latest.targetBatchId === plan.waiting.targetBatchId;
    const move = retrying
      ? await this.store.retry(latest.id)
      : await this.store.create({
          owner: this.feed.owner,
          topic: this.feed.topicHex,
          targetBatchId: plan.waiting.targetBatchId,
          fromBatchId: plan.waiting.fromBatchId,
          startedBy: describeActor(actor),
        });
    // Another start won the race; it is running.
    if (!move) return this.status();

    const from = move.fromBatchId ? shortBatch(move.fromBatchId) : 'the batch before the catalogue stamp';
    logger.info(
      `[CatalogueMove] ${describeActor(actor)} ${retrying ? 'retried' : 'started'} moving the catalogue from ${from} to ${shortBatch(move.targetBatchId)}: ${(head ?? 0) + 1} slots, from slot ${move.nextIndex}`,
    );
    await recordAudit(this.audit, {
      actor,
      action: 'catalogue.move.start',
      details: {
        moveId: move.id,
        targetBatchId: move.targetBatchId,
        fromBatchId: move.fromBatchId,
        slots: (head ?? 0) + 1,
        fromSlot: move.nextIndex,
        retry: retrying,
      },
    });
    this.launch(move, actor);
    return this.status();
  }

  /**
   * At boot: a move left running by a process that stopped goes on where it stopped. With the move turned off since,
   * it is failed with that reason instead, so the console does not show it running.
   */
  async resumeOnBoot(): Promise<void> {
    const latest = await this.store.latest(this.feed.owner, this.feed.topicHex);
    if (latest?.state !== 'running') return;
    const actor: Actor = { kind: 'system', reason: 'boot' };
    if (!this.options.enabled) {
      const message = `${catalogueMoveRefusal('disabled')} The move stopped at slot ${latest.nextIndex} and can be retried once it is.`;
      await this.stop(latest, actor, message);
      return;
    }
    logger.info(
      `[CatalogueMove] resuming the move to ${shortBatch(latest.targetBatchId)} at slot ${latest.nextIndex}, where it stopped`,
    );
    this.launch(latest, actor);
  }

  /** Resolves once the job running now, if any, has finished, failed or paused. For the tests. */
  async settled(): Promise<void> {
    await this.job;
  }

  /**
   * Stops the job after the slot it is on, leaving the move running in `catalogue_moves` so the next start resumes it.
   * Called before the database closes, so a shutdown is never recorded as a failure.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    await this.job;
  }

  private launch(move: CatalogueMoveRow, actor: Actor): void {
    const job: Promise<void> = this.run(move, actor).finally(() => {
      if (this.job === job) this.job = null;
    });
    this.job = job;
  }

  private async evaluate(): Promise<{
    plan: CatalogueMovePlan;
    latest: CatalogueMoveRow | null;
    head: number | null;
    covered: number;
    row: CatalogueStampRow | null;
  }> {
    const { owner, topicHex } = this.feed;
    const [row, last, latest] = await Promise.all([
      this.stamps.get(),
      this.history.lastWrite(owner, topicHex),
      this.store.latest(owner, topicHex),
    ]);
    const head = last?.index ?? null;
    const targetBatchId = isDesignated(row) ? row.record.batchId : null;
    let toRestamp = 0;
    let lacking = 0;
    let covered = 0;
    if (targetBatchId !== null && head !== null) {
      covered = await this.store.coveredBelow(owner, topicHex, targetBatchId);
      if (head >= covered) {
        const span = head - covered + 1;
        const counts = await this.store.slotCounts(owner, topicHex, targetBatchId, covered, head);
        toRestamp = span - counts.underTarget;
        lacking = span - counts.readable;
      }
    }
    const unfinished = latest !== null && latest.targetBatchId === targetBatchId && latest.state !== 'done';
    const plan = planCatalogueMove({
      enabled: this.options.enabled,
      row,
      head,
      toRestamp,
      lacking,
      unfinished,
      now: this.now(),
    });
    return { plan, latest, head, covered, row };
  }

  /**
   * The designated record the move stamps under, checked again before every slice: still designated, still the
   * move's batch, still one a write could go with. Anything else stops the move with the reason.
   */
  private async targetOf(move: CatalogueMoveRow): Promise<CatalogueTarget> {
    const row = await this.stamps.get();
    if (!isDesignated(row)) {
      const problem = row?.record ? 'cleared' : 'none';
      throw new MoveStopped(catalogueMoveRefusal(problem));
    }
    if (row.record.batchId !== move.targetBatchId) {
      throw new MoveStopped(
        `The manager designated batch ${shortBatch(row.record.batchId)} while the catalogue was being moved to ${shortBatch(move.targetBatchId)}. Start the move to the batch it designates now.`,
      );
    }
    const problem = refusalFor(row.record, this.now());
    if (problem) throw new MoveStopped(catalogueRefusal(problem, row.record.batchId));
    return { beeApiUrl: row.record.beeApiUrl, batchId: row.record.batchId };
  }

  private async head(): Promise<number> {
    const last = await this.history.lastWrite(this.feed.owner, this.feed.topicHex);
    if (!last) throw new MoveStopped('The feed has no recorded write any more, so there is no history to move.');
    return last.index;
  }

  private async run(start: CatalogueMoveRow, actor: Actor): Promise<void> {
    // The move as it was last recorded, which every slot moves on.
    const progress = { move: start };
    let target: CatalogueTarget | null = null;
    const done = new Set<string>();
    try {
      const covered = await this.store.coveredBelow(this.feed.owner, this.feed.topicHex, start.targetBatchId);

      // The history, in slices, while publishing goes on with the pinned batch.
      for (;;) {
        const slice = await this.targetOf(progress.move);
        target = slice;
        const head = await this.head();
        if (head - progress.move.nextIndex + 1 <= this.sliceSlots) {
          // The thumbnails named now; the last step does the ones named since.
          await this.restampThumbnails(slice, done);
          break;
        }
        await this.restampSlice(progress, slice, head, this.sliceSlots, covered);
      }
      if (this.stopping) throw new MovePaused();

      // The last step, under the publish mutex: nothing is written between the catch-up and the switch.
      const finished = await this.mutex.run(async () => {
        const last = await this.targetOf(progress.move);
        target = last;
        const head = await this.head();
        if (progress.move.nextIndex <= head) {
          await this.restampSlice(progress, last, head, head - progress.move.nextIndex + 1, covered);
        }
        await this.restampThumbnails(last, done);
        const row = await this.stamps.get();
        if (!isDesignated(row) || row.record.batchId !== progress.move.targetBatchId) {
          throw new MoveStopped('The designation changed during the last step of the move.');
        }
        const switched = await this.stamps.pin(row.record);
        const finishedMove = await this.store.finish(progress.move.id, done.size);
        if (!finishedMove) throw new MoveStopped('The move was no longer running when it finished.');
        return { move: finishedMove, switched, head };
      });

      const from = finished.move.fromBatchId;
      logger.info(
        `[CatalogueMove] the catalogue is moved to ${shortBatch(finished.move.targetBatchId)}: ${finished.head + 1} slots (${finished.move.restampedSlots} uploaded again, ${finished.move.skippedSlots} already under it), ${done.size} thumbnail${done.size === 1 ? '' : 's'}, and it is written with it from now on${
          from && from !== finished.move.targetBatchId
            ? `. Batch ${shortBatch(from)} can be released in the manager`
            : ''
        }`,
      );
      await recordAudit(this.audit, {
        actor,
        action: 'catalogue.move.done',
        details: {
          moveId: finished.move.id,
          targetBatchId: finished.move.targetBatchId,
          fromBatchId: from,
          slots: finished.head + 1,
          restamped: finished.move.restampedSlots,
          skipped: finished.move.skippedSlots,
          thumbnails: done.size,
          switched: finished.switched,
        },
      });
    } catch (error) {
      const at = progress.move.nextIndex;
      if (error instanceof MovePaused) {
        logger.info(
          `[CatalogueMove] the move to ${shortBatch(start.targetBatchId)} paused at slot ${at} for the shutdown; the next start resumes it there`,
        );
        return;
      }
      const raw = getErrorMessage(error);
      const message =
        error instanceof MoveStopped ? raw : `Slot ${at} could not be moved: ${withoutCatalogueNode(raw, target)}`;
      logger.error(`[CatalogueMove] the move to ${shortBatch(start.targetBatchId)} stopped at slot ${at}: ${raw}`);
      await this.stop(progress.move, actor, message);
    }
  }

  /** Fails the move with the reason, and audits it. A move that is not running any more is left as it is. */
  private async stop(move: CatalogueMoveRow, actor: Actor, message: string): Promise<void> {
    let failed: CatalogueMoveRow | null = null;
    try {
      failed = await this.store.fail(move.id, message);
    } catch (error) {
      logger.error(`[CatalogueMove] could not record why the move stopped: ${getErrorMessage(error)}`);
    }
    if (!failed) return;
    logger.warn(
      `[CatalogueMove] the move to ${shortBatch(failed.targetBatchId)} failed at slot ${failed.nextIndex}: ${message}`,
    );
    await recordAudit(this.audit, {
      actor,
      action: 'catalogue.move.failed',
      details: {
        moveId: failed.id,
        targetBatchId: failed.targetBatchId,
        fromBatchId: failed.fromBatchId,
        atSlot: failed.nextIndex,
        error: message,
      },
    });
  }

  /**
   * Slots `progress.move.nextIndex` onwards, `count` of them, in order, each recorded as it is done, so `progress`
   * always says where the move stands. A slot already under the target by the admin's record is left as it is:
   * written with it, uploaded again under it, or covered by a move to it that finished.
   */
  private async restampSlice(
    progress: { move: CatalogueMoveRow },
    target: CatalogueTarget,
    head: number,
    count: number,
    covered: number,
  ): Promise<void> {
    const from = progress.move.nextIndex;
    const to = from + count - 1;
    const rows = new Map<number, FeedSlotRow>(
      (await this.store.slots(this.feed.owner, this.feed.topicHex, from, to)).map((row) => [row.index, row]),
    );
    for (let index = from; index <= to; index += 1) {
      if (this.stopping) throw new MovePaused();
      const row = rows.get(index);
      const under = index < covered || row?.batchId === target.batchId || row?.restampedBatchId === target.batchId;
      if (!under) {
        await this.gateway.restampSlot(
          {
            index,
            // A head adopted from the network at boot (no reference, no batch) is not a write of this admin's: its text
            // is what a node answered, so its chunk is read from the network rather than signed again from it.
            payloadText: row && !(row.reference === null && row.batchId === null) ? row.payloadText : null,
            reference: row?.reference ?? null,
          },
          target,
        );
      }
      const recorded = await this.store.recordSlot(progress.move.id, {
        owner: this.feed.owner,
        topic: this.feed.topicHex,
        index,
        restamped: !under,
        head,
      });
      if (!recorded) throw new MoveStopped('The move was stopped while it ran.');
      progress.move = recorded;
    }
  }

  /**
   * Every thumbnail a stream names, published or not, and every one the latest entry names, uploaded again under the
   * target: a draft published again after the move names its thumbnail by the same reference, so it has to be under
   * the new batch too. The admin's stored bytes are used where a stream still holds the image, and the network
   * otherwise. Each one uploaded is recorded as under the target on the streams that name it
   * (`streams.thumbnail_batch_id`).
   *
   * A thumbnail the latest entry names has to come out at the reference the entry names, or the move stops before the
   * switch: the entry would still point at the old batch. An upload that fails stops the move as well, to be retried,
   * whenever the bytes were to hand. Only one no entry names only warns when the network cannot give it or it comes
   * out elsewhere: its stream keeps the batch it had recorded, so its next publish uploads it again under the batch
   * the catalogue is written with.
   */
  private async restampThumbnails(target: CatalogueTarget, done: Set<string>): Promise<void> {
    const last = await this.history.lastWrite(this.feed.owner, this.feed.topicHex);
    const named = new Set(thumbnailsNamedBy(last?.entries ?? []));
    const stored = new Map((await this.thumbnails.listStoredThumbnails()).map((t) => [t.reference.toLowerCase(), t]));
    for (const reference of new Set([...named, ...stored.keys()])) {
      if (done.has(reference)) continue;
      if (this.stopping) throw new MovePaused();
      const row = stored.get(reference);
      const file: ThumbnailFile | null = row?.thumbnail
        ? {
            bytes: new Uint8Array(row.thumbnail),
            filename: `${row.topic}.${THUMBNAIL_FILE_EXTENSIONS[row.thumbnail_mime ?? 'image/png'] ?? 'bin'}`,
            contentType: row.thumbnail_mime ?? 'image/png',
          }
        : null;
      let uploaded: string;
      try {
        uploaded = (await this.gateway.restampThumbnail(reference, file, target)).toLowerCase();
      } catch (error) {
        if (named.has(reference) || row?.thumbnail) {
          throw new MoveStopped(
            `The thumbnail ${reference} could not be uploaded again under batch ${shortBatch(target.batchId)}: ${withoutCatalogueNode(getErrorMessage(error), target)}. Nothing was switched.`,
          );
        }
        logger.warn(
          `[CatalogueMove] the thumbnail ${reference}, which no catalogue entry names, could not be uploaded again: ${getErrorMessage(error)}; its stream uploads it at its next publish`,
        );
        done.add(reference);
        continue;
      }
      if (uploaded !== reference) {
        if (named.has(reference)) {
          throw new MoveStopped(
            `The thumbnail ${reference} came out as ${uploaded} under batch ${shortBatch(target.batchId)}, so the entry that names it would still point at the old batch. Nothing was switched.`,
          );
        }
        logger.warn(
          `[CatalogueMove] the thumbnail ${reference}, which no catalogue entry names, came out as ${uploaded}; its stream uploads it at its next publish`,
        );
      } else if (row) {
        await this.thumbnails.recordThumbnailBatch(row.reference, target.batchId);
      }
      done.add(reference);
    }
  }
}

/** The thumbnail references the entries of a payload name, each once, in lower case. */
export function thumbnailsNamedBy(entries: unknown[]): string[] {
  const references = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const thumbnail = (entry as { thumbnail?: unknown }).thumbnail;
    if (typeof thumbnail === 'string' && REFERENCE_RE.test(thumbnail)) references.add(thumbnail.toLowerCase());
  }
  return [...references];
}
