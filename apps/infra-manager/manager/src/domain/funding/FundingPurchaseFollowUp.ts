import {
  ARCHIVE_PURCHASE_SETTLE_MS,
  getErrorMessage,
  PURCHASE_CHECK_NOTHING_REFUSAL,
  PURCHASE_FOLLOW_UP_MS,
  PURCHASE_NOT_USABLE_ERROR,
  PURCHASE_RELEASE_NOT_WAITING_REFUSAL,
  PURCHASE_RESTART_NOT_WAITING_REFUSAL,
  PURCHASE_USABLE_POLL_MS,
  purchaseStepOnceSet,
  type StampState,
} from '@streaming-infra-manager/common';
import {
  FUNDING_PURCHASE_USABLE_WAIT_SECONDS,
  type FundingPurchaseStep,
  fundingPurchaseApplySettled,
  fundingPurchaseRestartable,
} from '@streaming-monorepo/contracts';

import type { Profile } from '../../types/index.js';
import type { BeeStamp } from '../BeeClient.js';
import { ArchiveBatchRefusedError } from '../errors/index.js';
import { Logger } from '../Logger.js';
import type { ArchiveBatchDesignator, ArchiveBatchReader } from '../stages/archiveBatchPorts.js';
import { type CatalogueDesignationRow, isDesignated, isMoving } from '../stages/CatalogueDesignationRepository.js';
import { addressFree } from './addressFree.js';
import { FundingApiError } from './FundingApiError.js';
import { FUNDING_STATUS_READ_MS } from './FundingChainService.js';
import { batchFrom, saysNotHeld } from './FundingInventoryService.js';
import type {
  FundingPurchaseStageRow,
  FundingPurchaseStepPatch,
  FundingStampPurchaseJournal,
  FundingStampPurchasePatch,
  FundingStampPurchaseRow,
} from './FundingStampPurchaseJournal.js';
import type { PurchasedCatalogueBatches, PurchasedRungBatches, PurchaseStageApplier } from './purchaseFollowUpPorts.js';

const logger = Logger.getInstance();

/** What the follow-up reads from a purchase's node, `BeeClient` with the funding API's short read timeout. */
export interface FundingPurchaseReads {
  /** `GET /stamps`: the batches the node holds, each with the label it keeps for it. */
  listStamps(): Promise<BeeStamp[]>;
  /** `GET /stamps/{id}`, for a batch id without `0x`. */
  getStamp(batchId: string): Promise<BeeStamp>;
}

export interface FundingPurchaseFollowUpDeps {
  journal: FundingStampPurchaseJournal;
  /** The deployment whose own Bee node a node id names, or null when this manager runs none now. */
  deployment(nodeId: string): Promise<Profile | null>;
  /** The Bee API of a deployment's own Bee node, as the manager reaches it, `beeApiUrlFor`. */
  uploaderApiUrl(profile: Profile): string;
  /** The node at this Bee API, read for a purchase's batch. */
  reads(apiUrl: string): FundingPurchaseReads;
  /** The archive batches, none of which a settle takes for a purchase's batch. */
  archiveBatches: ArchiveBatchReader;
  /** The catalogue designation, whose pinned batch, and the one a pending move left, a settle never takes. */
  catalogue: { read(): Promise<CatalogueDesignationRow> };
  /** What makes a bought archive stamp an archive batch, and pushes the catalogue stamp record. */
  designator: ArchiveBatchDesignator;
  /** The ports that put a rung's and the catalogue's batch to use (`purchaseFollowUpPorts.ts`). */
  rungs: PurchasedRungBatches;
  stages: PurchaseStageApplier;
  catalogueBatches: PurchasedCatalogueBatches;
  now?: () => number;
  /** How often the background sweep runs, {@link PURCHASE_FOLLOW_UP_MS} by default. */
  sweepMs?: number;
  /** How soon a purchase whose batch is not usable yet is looked at again, {@link PURCHASE_USABLE_POLL_MS} by default. */
  usablePollMs?: number;
}

/** A batch id as Bee spells one, with or without `0x`, in either case. */
const BATCH_ID = /^(0[xX])?[0-9a-fA-F]{64}$/;

const NOT_FOUND = 'The node lists no batch under this purchase’s label thirty minutes after it was asked.';
const NODE_UNREAD =
  'The node could not be read about the batch, so whether it is usable is not known. Check again once the node answers.';
const NODE_GONE = 'No deployment of this manager runs the node that bought the batch any more.';
const NO_SUCH_STAGE = 'This purchase follows no stage with this id.';
const STAGE_UNREAD = 'The stage could not be read, so nothing was restarted. Try again in a moment.';

function refused(message: string): FundingApiError {
  return new FundingApiError('stamp_refused', message);
}

/** A stage's words as a log line ends with them, whole, a node's address included; nothing when it has none. */
function wholly(message: string | null): string {
  return message === null ? '' : `: ${message}`;
}

/** A batch id as the funding API prints one, `0x` and 64 hex digits in lower case, or null for anything else. */
export function batchIdFrom(value: unknown): string | null {
  if (typeof value !== 'string' || !BATCH_ID.test(value)) return null;
  return `0x${value.slice(-64).toLowerCase()}`;
}

/** A batch id as the manager's own records keep one: 64 hex digits without `0x`, in lower case. */
export function bareBatchId(id: string): string {
  return id.replace(/^0x/i, '').toLowerCase();
}

/** Bee's word about a batch it answered for, or null when the answer is not about that batch or says nothing. */
export function usableOf(stamp: BeeStamp | null, batchId: string): boolean | null {
  if (stamp === null || typeof stamp !== 'object' || batchIdFrom(stamp.batchID) !== batchId) return null;
  return typeof stamp.usable === 'boolean' ? stamp.usable : null;
}

/**
 * A batch a purchase bought, as its node answered about it: whether the node calls it usable, and its state in the
 * words the inventory gives a batch (`batchFrom`), `gone` when the node answered 404 for it and `unknown` when it
 * could not be read about it.
 */
export interface BoughtBatchOnNode {
  usable: boolean | null;
  state: StampState;
}

/**
 * A bought batch, `0x` and 64 hex digits, as one answer of its node reads it, a `GET /stamps/{id}` or an entry of its
 * `GET /stamps`: the inventory's verdict on it, and whether the node calls it usable.
 */
export function boughtBatchOf(batchId: string, stamp: BeeStamp): BoughtBatchOnNode {
  return { usable: usableOf(stamp, batchId), state: batchFrom(bareBatchId(batchId), stamp).state ?? 'unknown' };
}

/** What a settle knows of the batches a purchase's batch can never be: the catalogue's own and the archive batches. */
interface TakenBatches {
  catalogue: readonly string[];
  archive: readonly string[];
}

/**
 * Whether a batch the node lists is the one a purchase with a lost answer bought: it carries exactly the purchase's
 * label, has the purchase's depth and kind, and is neither the catalogue's batch nor an archive batch already, since a
 * batch holds one role. For an archive stamp this is the rule `isPurchasedArchiveBatch` gives.
 */
function isPurchasedBatch(stamp: BeeStamp, row: FundingStampPurchaseRow, taken: TakenBatches): boolean {
  const batchId = batchIdFrom(stamp.batchID);
  if (batchId === null || stamp.label !== row.nodeLabel) return false;
  if (stamp.depth !== row.depth || stamp.immutableFlag !== row.immutable) return false;
  const bare = bareBatchId(batchId);
  return !taken.catalogue.includes(bare) && !taken.archive.includes(bare);
}

/** The patch that keeps a row's set, previous batch and release as they are while its step changes. */
function stepPatch(
  row: FundingStampPurchaseRow,
  change: Partial<FundingPurchaseStepPatch> & Pick<FundingPurchaseStepPatch, 'step' | 'updatedAt'>,
): FundingPurchaseStepPatch {
  return {
    error: null,
    setAt: row.setAt,
    previousBatchId: row.previousBatchId,
    releasedAt: row.releasedAt,
    ...change,
  };
}

/**
 * The follow-up of the funding API's batch purchases, which runs in the manager in the background, every
 * {@link PURCHASE_FOLLOW_UP_MS} and at boot, from the step each purchase's row holds
 * (`docs/features/postage-stamps.md`, "Bought from the admin"):
 *
 * - **`buying`, `unknown`.** A purchase whose answer was lost is settled from the node's own list of batches: the
 *   batch with exactly the purchase's label, depth and kind, that holds no other role, makes it `confirmed`, and none
 *   {@link ARCHIVE_PURCHASE_SETTLE_MS} after the request makes it `failed`.
 * - **`waiting_usable`.** The bought batch is read every {@link PURCHASE_USABLE_POLL_MS} until its node calls it
 *   usable, and the follow-up stops as `failed` once {@link FUNDING_PURCHASE_USABLE_WAIT_SECONDS} have passed since it
 *   was bought. An archive stamp is made an archive batch as soon as it is `confirmed`.
 * - **Usable.** A rung's batch is set through {@link PurchasedRungBatches.set}, which answers the stages that follow
 *   the rung, kept in `funding_purchase_stages`; the catalogue's is designated as a move through
 *   {@link PurchasedCatalogueBatches.designate}; an archive stamp is done once it is recorded. A port's refusal stops
 *   the purchase as `failed` with its sentence.
 * - **`set`, for a rung.** The stages are taken in order, at most one Apply at a time: an Apply under way is looked at
 *   first, then each unsettled stage, and the pass ends at the first look that starts an Apply. A stage that waits, for
 *   a broadcast or for other settings, does not hold the later ones back. Once every stage is settled the purchase is
 *   `done`.
 *
 * Restart, check and release are the admin's three calls under a purchase, each run in turn with the follow-up of the
 * same purchase. One purchase's follow-up never runs twice at once.
 */
export class FundingPurchaseFollowUp {
  private readonly now: () => number;
  private readonly sweepMs: number;
  private readonly usablePollMs: number;
  /** The tail of each purchase's work, so its follow-up and its calls run one after another. */
  private readonly tails = new Map<string, Promise<void>>();
  /** The advance of each purchase that is under way, so a sweep never starts a second one. */
  private readonly advancing = new Map<string, Promise<void>>();
  /** The purchases a timer will advance again, by request id. */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** When each request id's node was last listed for a settle, for {@link FUNDING_STATUS_READ_MS}. */
  private readonly lastSettleRead = new Map<string, number>();
  /** The stages a check asked to take up again, `<requestId> <stageId>`, until the next look at each. */
  private readonly retryAsked = new Set<string>();
  /** The request ids whose batch the archive batches refused, logged once each while the manager runs. */
  private readonly refusalLogged = new Set<string>();
  private interval: NodeJS.Timeout | null = null;
  private sweeping: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly deps: FundingPurchaseFollowUpDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sweepMs = deps.sweepMs ?? PURCHASE_FOLLOW_UP_MS;
    this.usablePollMs = deps.usablePollMs ?? PURCHASE_USABLE_POLL_MS;
  }

  /** Sweeps once now, at boot, and then every {@link PURCHASE_FOLLOW_UP_MS}. */
  start(): void {
    if (this.interval || this.stopping) return;
    void this.sweep();
    this.interval = setInterval(() => void this.sweep(), this.sweepMs);
    this.interval.unref();
  }

  /** Stops the sweep and the timers, and waits for the work under way. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.settled();
  }

  /** Resolves once the sweep and every purchase's work under way have ended. */
  async settled(): Promise<void> {
    for (;;) {
      const pending = [...this.tails.values(), ...(this.sweeping ? [this.sweeping] : [])];
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  /** Advances every purchase there is something left to do for, each on its own. A sweep never runs twice at once. */
  sweep(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.sweeping) return this.sweeping;
    const sweeping = (async () => {
      try {
        const rows = await this.deps.journal.following();
        await Promise.all(rows.map((row) => this.advance(row.requestId)));
      } catch (err) {
        logger.warn(`[Funding] the batch purchases could not be followed up this time: ${getErrorMessage(err)}`);
      }
    })();
    this.sweeping = sweeping.finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  /**
   * Takes one purchase one step further, as far as it can go now, unless that is under way already. Never rejects: a
   * failure is logged, and the next sweep tries again.
   */
  advance(requestId: string): Promise<void> {
    const running = this.advancing.get(requestId);
    if (running) return running;
    const advance = this.exclusive(requestId, () => this.advanceOnce(requestId))
      .catch((err: unknown) => {
        logger.warn(`[Funding] batch purchase ${requestId} could not be followed up: ${getErrorMessage(err)}`);
      })
      .finally(() => this.advancing.delete(requestId));
    this.advancing.set(requestId, advance);
    return advance;
  }

  /**
   * An `unknown` purchase settled from the node's own list of batches, as {@link FundingPurchaseFollowUp} says. The
   * node is read at most once every {@link FUNDING_STATUS_READ_MS} for a request id; in between, and when the node is
   * gone or does not answer, the row is answered as journalled. Answers the batch as the node listed it, when the row
   * was confirmed by it.
   */
  async settle(
    row: FundingStampPurchaseRow,
    apiUrl: string | null,
  ): Promise<{ row: FundingStampPurchaseRow; stamp: BeeStamp | null }> {
    const unchanged = { row, stamp: null };
    if (row.state !== 'unknown' || apiUrl === null) return unchanged;
    const now = this.now();
    const last = this.lastSettleRead.get(row.requestId);
    if (last !== undefined && now - last < FUNDING_STATUS_READ_MS) return unchanged;
    this.lastSettleRead.set(row.requestId, now);
    let stamps: unknown;
    try {
      stamps = await this.deps.reads(apiUrl).listStamps();
    } catch (err) {
      logger.debug(
        `[Funding] could not read the batches of the node of batch purchase ${row.requestId} (${err instanceof Error ? err.name : 'no error'}); answering it as journalled`,
      );
      return unchanged;
    }
    const labelled = (Array.isArray(stamps) ? (stamps as BeeStamp[]) : []).filter(
      (stamp) =>
        typeof stamp === 'object' &&
        stamp !== null &&
        stamp.label === row.nodeLabel &&
        batchIdFrom(stamp.batchID) !== null,
    );
    // The batches it can never be are read only once the node lists one under the purchase's label.
    const taken = labelled.length > 0 ? await this.takenBatches() : null;
    const found = (taken && labelled.find((stamp) => isPurchasedBatch(stamp, row, taken))) ?? null;

    let patch: FundingStampPurchasePatch;
    const at = new Date(now);
    if (found) {
      patch = {
        state: 'confirmed',
        batchId: batchIdFrom(found.batchID),
        txHash: row.txHash,
        error: null,
        updatedAt: at,
        step: 'waiting_usable',
        boughtAt: at,
      };
    } else if (now - row.createdAt.getTime() > ARCHIVE_PURCHASE_SETTLE_MS) {
      patch = {
        state: 'failed',
        batchId: null,
        txHash: row.txHash,
        error: NOT_FOUND,
        updatedAt: at,
        step: 'failed',
        boughtAt: null,
      };
    } else {
      return unchanged;
    }
    if (!(await this.deps.journal.update(row.requestId, 'unknown', patch))) {
      // The node's answer was written meanwhile, and it stands.
      return { row: (await this.deps.journal.find(row.requestId)) ?? row, stamp: null };
    }
    this.lastSettleRead.delete(row.requestId);
    logger.info(
      `[Funding] batch purchase ${row.requestId} is ${patch.state}${patch.batchId ? `, batch ${patch.batchId}` : ''}, read from the node’s batches`,
    );
    return { row: { ...row, ...patch }, stamp: found };
  }

  /** The node's word now about whether a bought batch is usable, or null when it could not be read. Never throws. */
  async usable(batchId: string, apiUrl: string | null): Promise<boolean | null> {
    if (apiUrl === null) return null;
    try {
      return usableOf(await this.deps.reads(apiUrl).getStamp(bareBatchId(batchId)), batchId);
    } catch (err) {
      logger.debug(
        `[Funding] could not read batch ${batchId} on its node (${err instanceof Error ? err.name : 'no error'}); answering whether it is usable as not known`,
      );
      return null;
    }
  }

  /**
   * A bought batch on its node, read once with `GET /stamps/{id}` ({@link boughtBatchOf}): `gone` when the node answers
   * 404 for it, as the inventory reads a 404, and `unknown`, with whether it is usable not known, when the node could
   * not be read about it. Never throws.
   */
  async onNode(batchId: string, apiUrl: string): Promise<BoughtBatchOnNode> {
    try {
      return boughtBatchOf(batchId, await this.deps.reads(apiUrl).getStamp(bareBatchId(batchId)));
    } catch (err) {
      if (saysNotHeld(err)) return { usable: null, state: 'gone' };
      logger.debug(
        `[Funding] could not read batch ${batchId} on its node (${err instanceof Error ? err.name : 'no error'}); answering its state as not known`,
      );
      return { usable: null, state: 'unknown' };
    }
  }

  /**
   * Makes the batch a confirmed archive stamp bought an archive batch through `designateArchiveBatch`, which writes its
   * row, raises the revision and pushes the catalogue stamp record, and marks the purchase `recorded_at` once it did.
   * Answers the purchase as it stands after, and the refusal when the archive batches refused the batch, since it has
   * become the catalogue's own; a refusal is logged once. A purchase marked already is never designated again, so a
   * batch taken off the list stays off it. Any other failure is logged and leaves the purchase unmarked for the next
   * try. Never throws.
   */
  async designateArchive(
    row: FundingStampPurchaseRow,
    profileName: string,
  ): Promise<{ row: FundingStampPurchaseRow; refusal: string | null }> {
    if (row.purpose !== 'archive' || row.batchId === null || row.recordedAt !== null || row.state !== 'confirmed') {
      return { row, refusal: null };
    }
    try {
      await this.deps.designator.designateArchiveBatch({
        batchId: bareBatchId(row.batchId),
        profileName,
        depth: row.depth,
        label: row.label,
        designatedBy: null,
        purchaseRequestId: row.requestId,
      });
    } catch (err) {
      if (err instanceof ArchiveBatchRefusedError) {
        if (!this.refusalLogged.has(row.requestId)) {
          this.refusalLogged.add(row.requestId);
          logger.warn(
            `[Funding] batch purchase ${row.requestId} bought ${row.batchId}, which is not made an archive batch: ${err.message} The purchase stays confirmed and unrecorded.`,
          );
        }
        return { row, refusal: err.message };
      }
      logger.warn(
        `[Funding] batch purchase ${row.requestId} bought ${row.batchId}, which could not be made an archive batch yet: ${getErrorMessage(err)}`,
      );
      return { row, refusal: null };
    }
    const at = new Date(this.now());
    try {
      await this.deps.journal.markRecorded(row.requestId, at);
    } catch (err) {
      // The designation stands; it changes nothing when the next try makes it again.
      logger.warn(`[Funding] batch purchase ${row.requestId} could not be marked recorded: ${getErrorMessage(err)}`);
      return { row, refusal: null };
    }
    return { row: { ...row, recordedAt: at }, refusal: null };
  }

  /**
   * The admin's Restart now: runs the Apply of one stage of a rung purchase although a broadcast is live on it or the
   * manager cannot tell. Taken only while that stage waits for a broadcast (`fundingPurchaseRestartable`); refused with
   * `stamp_refused` otherwise, and when the stage could not be read.
   */
  restart(requestId: string, stageId: string): Promise<void> {
    return this.exclusive(requestId, async () => {
      const row = await this.found(requestId);
      const stages = row.purpose === 'rung' ? await this.deps.journal.stagesOf(requestId) : [];
      const stage = stages.find((each) => each.stageId === stageId);
      if (!stage) throw refused(NO_SUCH_STAGE);
      if (row.step !== 'set' || row.batchId === null || !fundingPurchaseRestartable(stage.apply)) {
        throw refused(PURCHASE_RESTART_NOT_WAITING_REFUSAL);
      }
      let look;
      try {
        look = await this.deps.stages.look({
          stageId,
          batchId: bareBatchId(row.batchId),
          force: true,
          retryFailed: false,
        });
      } catch (err) {
        logger.warn(
          `[Funding] batch purchase ${requestId} could not restart stage ${stage.name}: ${getErrorMessage(err)}`,
        );
        throw refused(STAGE_UNREAD);
      }
      const at = new Date(this.now());
      await this.deps.journal.updateStage(requestId, stageId, {
        apply: look.apply,
        message: look.message === null ? null : addressFree(look.message),
        updatedAt: at,
        forcedAt: at,
      });
      logger.info(
        `[Funding] batch purchase ${requestId}: the admin asked to restart stage ${stage.name} now, which is ${look.apply}${wholly(look.message)}`,
      );
      await this.finishIfSettled(row);
    });
  }

  /**
   * The admin's Check again: takes up a purchase that stopped as `failed` after its batch was bought, reading the node
   * once, and a rung purchase's stages whose Apply failed. Refused with `stamp_refused` when nothing stopped.
   */
  check(requestId: string): Promise<void> {
    return this.exclusive(requestId, async () => {
      const row = await this.found(requestId);
      if (row.step === 'failed') {
        if (row.state !== 'confirmed' || row.batchId === null) throw refused(PURCHASE_CHECK_NOTHING_REFUSAL);
        logger.info(`[Funding] batch purchase ${requestId}: the admin asked to check it again`);
        await this.putToUseIfUsable(row, 'failed');
        return;
      }
      if (row.purpose === 'rung' && row.step === 'set') {
        const failed = (await this.deps.journal.stagesOf(requestId)).filter((stage) => stage.apply === 'failed');
        if (failed.length > 0) {
          for (const stage of failed) this.retryAsked.add(`${requestId} ${stage.stageId}`);
          logger.info(
            `[Funding] batch purchase ${requestId}: the admin asked to apply again ${failed.map((stage) => stage.name).join(', ')}`,
          );
          await this.passStages(row);
          return;
        }
      }
      throw refused(PURCHASE_CHECK_NOTHING_REFUSAL);
    });
  }

  /**
   * The admin's release of the batch a catalogue purchase moved the catalogue from, taken as its word that its move of
   * the catalogue is done, which the manager cannot see. A release made already is answered as it stands. Refused with
   * `stamp_refused` for a purchase with no previous batch waiting, and with the port's sentence when the designation
   * has moved on since.
   */
  release(requestId: string): Promise<void> {
    return this.exclusive(requestId, async () => {
      const row = await this.found(requestId);
      if (row.purpose === 'catalogue' && row.releasedAt !== null) return;
      if (row.purpose !== 'catalogue' || row.step !== 'set' || row.previousBatchId === null || row.batchId === null) {
        throw refused(PURCHASE_RELEASE_NOT_WAITING_REFUSAL);
      }
      try {
        await this.deps.catalogueBatches.release({
          batchId: bareBatchId(row.batchId),
          previousBatchId: bareBatchId(row.previousBatchId),
          requestId,
        });
      } catch (err) {
        // The log keeps the port's sentence whole; the admin reads it without a node's address.
        const said = getErrorMessage(err);
        logger.warn(`[Funding] batch purchase ${requestId} could not release ${row.previousBatchId}: ${said}`);
        throw refused(addressFree(said));
      }
      const at = new Date(this.now());
      await this.deps.journal.advance(
        requestId,
        'set',
        stepPatch(row, { step: 'done', updatedAt: at, releasedAt: at }),
      );
      logger.info(
        `[Funding] batch purchase ${requestId} released the previous catalogue batch ${row.previousBatchId}, on the admin’s word that its move of the catalogue is done`,
      );
    });
  }

  /** Runs `task` after every earlier piece of work on the same purchase, and before any later one. */
  private exclusive<T>(requestId: string, task: () => Promise<T>): Promise<T> {
    const before = this.tails.get(requestId) ?? Promise.resolve();
    const run = before.then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(requestId, tail);
    void tail.then(() => {
      if (this.tails.get(requestId) === tail) this.tails.delete(requestId);
    });
    return run;
  }

  /** The purchase's row, or `unknown_request` when none was journalled under the id. */
  private async found(requestId: string): Promise<FundingStampPurchaseRow> {
    const row = await this.deps.journal.find(requestId);
    if (!row) {
      throw new FundingApiError(
        'unknown_request',
        'No batch purchase was journalled under this request id, so sending it again under the same id is safe.',
      );
    }
    return row;
  }

  /** Looks at the purchase again after the usable poll's pause, unless a look is planned already or it is stopping. */
  private later(requestId: string): void {
    if (this.stopping || this.timers.has(requestId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(requestId);
      void this.advance(requestId);
    }, this.usablePollMs);
    timer.unref();
    this.timers.set(requestId, timer);
  }

  private async advanceOnce(requestId: string): Promise<void> {
    if (this.stopping) return;
    let row = await this.deps.journal.find(requestId);
    if (!row) return;
    if (row.step === 'buying') {
      const deployment = await this.deps.deployment(row.nodeId);
      row = (await this.settle(row, deployment ? this.deps.uploaderApiUrl(deployment) : null)).row;
    }
    if (row.step === 'waiting_usable') {
      if (!(await this.putToUseIfUsable(row, 'waiting_usable'))) this.later(requestId);
      return;
    }
    if (row.step === 'set' && row.purpose === 'rung') await this.passStages(row);
  }

  /**
   * Puts a bought batch to use once its node calls it usable, from the step the purchase is at, `waiting_usable` or
   * `failed` on a check. Answers whether the purchase is past waiting: put to use, or stopped as failed. A batch not
   * usable yet stops it once the hour since it was bought is over, and on a check at once.
   */
  private async putToUseIfUsable(
    row: FundingStampPurchaseRow,
    from: Extract<FundingPurchaseStep, 'waiting_usable' | 'failed'>,
  ): Promise<boolean> {
    const deployment = await this.deps.deployment(row.nodeId);
    if (!deployment) {
      if (from === 'failed' || this.waitIsOver(row)) {
        await this.fail(row, from, from === 'failed' ? NODE_GONE : PURCHASE_NOT_USABLE_ERROR);
        return true;
      }
      return false;
    }
    let current = row;
    let refusal: string | null = null;
    if (current.purpose === 'archive')
      ({ row: current, refusal } = await this.designateArchive(current, deployment.name));
    const usable = await this.usable(current.batchId!, this.deps.uploaderApiUrl(deployment));
    if (usable !== true) {
      if (from === 'failed') {
        await this.fail(current, from, usable === false ? PURCHASE_NOT_USABLE_ERROR : NODE_UNREAD);
        return true;
      }
      if (this.waitIsOver(current)) {
        await this.fail(current, from, PURCHASE_NOT_USABLE_ERROR);
        return true;
      }
      return false;
    }
    if (current.purpose === 'archive') {
      if (refusal !== null) {
        await this.fail(current, from, refusal);
        return true;
      }
      if (current.recordedAt === null) {
        // The designation failed for another reason, and is tried again at the next look.
        if (from === 'failed' || this.waitIsOver(current)) {
          await this.fail(current, from, 'The batch is usable, and it could not be made an archive batch yet.');
          return true;
        }
        return false;
      }
      await this.deps.journal.advance(
        current.requestId,
        from,
        stepPatch(current, { step: 'done', updatedAt: new Date(this.now()) }),
      );
      logger.info(`[Funding] batch purchase ${current.requestId}: the archive stamp ${current.batchId} is usable`);
      return true;
    }
    await this.putToUse(current, deployment, from);
    return true;
  }

  /** Whether the hour of waiting for a usable batch, counted from the purchase's confirmation, is over. */
  private waitIsOver(row: FundingStampPurchaseRow): boolean {
    const since = (row.boughtAt ?? row.updatedAt).getTime();
    return this.now() - since >= FUNDING_PURCHASE_USABLE_WAIT_SECONDS * 1000;
  }

  /**
   * Stops the purchase as failed, from the step it is at, with the sentence that says why. The row, which the admin
   * reads, keeps it without a node's address, and the log keeps it whole.
   */
  private async fail(row: FundingStampPurchaseRow, from: FundingPurchaseStep, error: string): Promise<void> {
    const moved = await this.deps.journal.advance(
      row.requestId,
      from,
      stepPatch(row, { step: 'failed', error: addressFree(error), updatedAt: new Date(this.now()) }),
    );
    if (moved) logger.warn(`[Funding] batch purchase ${row.requestId} stopped as failed: ${error}`);
  }

  /**
   * Sets a usable rung batch, or designates a usable catalogue batch, through its port, and writes the step it comes
   * to. A rung's stages are written before the step, so a purchase is never `set` without them.
   */
  private async putToUse(
    row: FundingStampPurchaseRow,
    deployment: Profile,
    from: Extract<FundingPurchaseStep, 'waiting_usable' | 'failed'>,
  ): Promise<void> {
    const batchId = bareBatchId(row.batchId!);
    const at = new Date(this.now());
    if (row.purpose === 'rung') {
      let followers;
      try {
        followers = await this.deps.rungs.set({ profileName: deployment.name, batchId, requestId: row.requestId });
      } catch (err) {
        await this.fail(row, from, getErrorMessage(err));
        return;
      }
      const stages: FundingPurchaseStageRow[] = followers.map((follower, position) => ({
        stageId: follower.stageId,
        name: follower.name,
        position,
        apply: follower.following ? 'pending' : 'not_following',
        message: null,
        forcedAt: null,
        updatedAt: at,
      }));
      await this.deps.journal.addStages(row.requestId, stages);
      const written = await this.deps.journal.stagesOf(row.requestId);
      const step = purchaseStepOnceSet('rung', written, null);
      if (!(await this.deps.journal.advance(row.requestId, from, stepPatch(row, { step, updatedAt: at, setAt: at })))) {
        return;
      }
      logger.info(
        `[Funding] batch purchase ${row.requestId} set ${row.batchId} on ${deployment.name}, followed by ${written.length} stage${written.length === 1 ? '' : 's'}`,
      );
      if (step === 'set') await this.passStages({ ...row, step, setAt: at });
      return;
    }
    let previous: string | null;
    try {
      ({ previousBatchId: previous } = await this.deps.catalogueBatches.designate({
        profileName: deployment.name,
        batchId,
        requestId: row.requestId,
      }));
    } catch (err) {
      await this.fail(row, from, getErrorMessage(err));
      return;
    }
    const previousBatchId = previous === null ? null : `0x${bareBatchId(previous)}`;
    const step = purchaseStepOnceSet('catalogue', [], { previousBatchId, released: false });
    const moved = await this.deps.journal.advance(
      row.requestId,
      from,
      stepPatch(row, { step, updatedAt: at, setAt: at, previousBatchId }),
    );
    if (moved) {
      logger.info(
        `[Funding] batch purchase ${row.requestId} designated ${row.batchId} as the catalogue batch${previousBatchId ? `, moving from ${previousBatchId}` : ''}`,
      );
    }
  }

  /**
   * One pass over a rung purchase's stages, at most one Apply at a time: an Apply under way is looked at first and ends
   * the pass while it still runs; then each unsettled stage in order, until a look starts an Apply. A stage the check
   * asked for is looked at with `retryFailed`. A look that rejects leaves its stage as it was for the next pass.
   */
  private async passStages(row: FundingStampPurchaseRow): Promise<void> {
    if (row.batchId === null) return;
    const batchId = bareBatchId(row.batchId);
    const stages = await this.deps.journal.stagesOf(row.requestId);
    const applying = stages.filter((stage) => stage.apply === 'applying');
    const rest = stages.filter((stage) => stage.apply !== 'applying' && !fundingPurchaseApplySettled(stage.apply));
    for (const stage of [...applying, ...rest]) {
      const key = `${row.requestId} ${stage.stageId}`;
      const retryFailed = this.retryAsked.has(key);
      let look;
      try {
        look = await this.deps.stages.look({ stageId: stage.stageId, batchId, force: false, retryFailed });
      } catch (err) {
        logger.debug(
          `[Funding] batch purchase ${row.requestId} could not look at stage ${stage.name} this time: ${getErrorMessage(err)}`,
        );
        continue;
      }
      this.retryAsked.delete(key);
      // The stage's words as the admin reads them, which are what the row holds and what a later look is set against.
      const message = look.message === null ? null : addressFree(look.message);
      if (look.apply !== stage.apply || message !== stage.message) {
        await this.deps.journal.updateStage(row.requestId, stage.stageId, {
          apply: look.apply,
          message,
          updatedAt: new Date(this.now()),
        });
        logger.info(
          `[Funding] batch purchase ${row.requestId}: stage ${stage.name} is ${look.apply}${wholly(look.message)}`,
        );
      }
      if (look.apply === 'applying') break;
    }
    await this.finishIfSettled(row);
  }

  /** Marks a `set` rung purchase `done` once every one of its stages is settled. */
  private async finishIfSettled(row: FundingStampPurchaseRow): Promise<void> {
    if (row.purpose !== 'rung') return;
    const stages = await this.deps.journal.stagesOf(row.requestId);
    if (purchaseStepOnceSet('rung', stages, null) !== 'done') return;
    const current = (await this.deps.journal.find(row.requestId)) ?? row;
    if (current.step !== 'set') return;
    const moved = await this.deps.journal.advance(
      row.requestId,
      'set',
      stepPatch(current, { step: 'done', updatedAt: new Date(this.now()) }),
    );
    if (moved) logger.info(`[Funding] batch purchase ${row.requestId} is done: every stage that follows is settled`);
  }

  /** The batches a purchase's batch can never be, each 64 hex digits without `0x` in lower case. */
  private async takenBatches(): Promise<TakenBatches> {
    const [archived, designation] = await Promise.all([this.deps.archiveBatches.list(), this.deps.catalogue.read()]);
    const catalogue: string[] = [];
    if (isDesignated(designation)) catalogue.push(bareBatchId(designation.batchId));
    if (isMoving(designation)) catalogue.push(bareBatchId(designation.movingFromBatchId));
    return { catalogue, archive: archived.map((batch) => bareBatchId(batch.batchId)) };
  }
}
