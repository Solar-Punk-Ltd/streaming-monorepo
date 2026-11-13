import {
  ARCHIVE_ALREADY_REFUSAL,
  ARCHIVE_NO_CATALOGUE_NODE_REFUSAL,
  ARCHIVE_NOT_HELD_REFUSAL,
  ARCHIVE_UNREACHABLE_REFUSAL,
  type ArchiveBatchAdopt,
  type ArchiveBatchCandidate,
  type ArchiveBatchDesignation,
  type ArchiveBatchesAnswer,
  type ArchiveBatchRemove,
  type ArchiveBatchRow,
  archiveBatchProblem,
  archiveIsCatalogueBatchRefusal,
  archiveLabelProblem,
  archiveRemoveProblem,
  type CataloguePushState,
  type CatalogueReading,
  getErrorMessage,
  shortHex,
  type StampState,
  stampHealthFrom,
} from '@streaming-infra-manager/common';

import type { BeeStamp } from '../BeeClient.js';
import {
  ArchiveBatchNotFoundError,
  ArchiveBatchRefusedError,
  ManagerSettingsChangedError,
  ProfileNotFoundError,
  StampNotFoundError,
} from '../errors/index.js';
import { Logger } from '../Logger.js';

import type { ArchiveBatchDesignator, ArchiveBatchReader, ArchiveBatchToDesignate } from './archiveBatchPorts.js';
import type { ArchiveBatchStore, ArchiveBatchWrite } from './ArchiveBatchRepository.js';
import { type CatalogueDesignationRow, isDesignated } from './CatalogueDesignationRepository.js';

const logger = Logger.getInstance();

/** A batch id as Bee prints one, with or without `0x`. */
const BATCH_ID_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/** The states in which the node takes a chunk stamped with the batch: usable, and with life left. */
const WRITABLE_STATES: ReadonlySet<StampState> = new Set(['active', 'full']);

/**
 * Whether the web2 admin may copy recordings onto an archive batch: its deployment is the designated catalogue node,
 * and that node's last reading calls it usable with life left. A full batch stays writable, since only its full
 * buckets refuse a chunk, and the admin pauses on its state. A batch left on a node that is the catalogue node no
 * longer, one not yet usable, an expired one and one whose node did not answer are not.
 */
export function archiveBatchWritable(
  profileName: string,
  catalogueProfileName: string | null,
  state: StampState | null,
): boolean {
  if (catalogueProfileName === null || profileName !== catalogueProfileName || state === null) return false;
  return WRITABLE_STATES.has(state);
}

/** What the catalogue publisher last read of the archive batches, and how its last push went. */
export interface ArchiveBatchStatus {
  /** The last reading of each archive batch, by batch id. */
  readings: ReadonlyMap<string, CatalogueReading>;
  lastPush: CataloguePushState | null;
}

export interface ArchiveBatchServiceDeps {
  store: ArchiveBatchStore;
  designation: { read(): Promise<CatalogueDesignationRow> };
  /** Every batch a deployment's node holds, `StampService.listStamps`. */
  listStamps(name: string): Promise<BeeStamp[]>;
  /** One batch as the deployment's node reports it now, `StampService.heldBatch`. */
  heldBatch(name: string, batchId: string): Promise<BeeStamp>;
  /** What the catalogue publisher last read and sent, for the answer. */
  status(): ArchiveBatchStatus;
  /** Tells the catalogue publisher the archive batches changed, so it pushes now. */
  changed(): void;
  now?: () => number;
}

/**
 * The brand's archive batches: immutable batches on the catalogue node that the web2 admin copies finished recordings
 * onto. A purchase through the funding API, and an adopt on the Manager settings page of a batch bought another way,
 * both make one through {@link ArchiveBatchDesignator}. The settings page removes one that expired, and the funding
 * API lists them ({@link ArchiveBatchReader}). Every change pushes the catalogue stamp record, which carries them.
 *
 * A batch stays with the deployment whose node holds it. Once the catalogue node is designated anew on another
 * deployment, the batches of the old one stay listed and are pushed as not writable. Removing that deployment leaves
 * them listed as `unknown`, without a node that can top them up.
 *
 * The manager keeps no audit table: each change is logged with the user who made it, and the row records who and
 * when.
 */
export class ArchiveBatchService implements ArchiveBatchReader, ArchiveBatchDesignator {
  private readonly now: () => number;

  constructor(private readonly deps: ArchiveBatchServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  list(): Promise<ArchiveBatchDesignation[]> {
    return this.deps.store.list();
  }

  async read(): Promise<ArchiveBatchesAnswer> {
    const [row, batches, revision] = await Promise.all([
      this.deps.designation.read(),
      this.deps.store.list(),
      this.deps.store.revision(),
    ]);
    const catalogueProfileName = isDesignated(row) ? row.profileName : null;
    const { readings, lastPush } = this.deps.status();
    const rows: ArchiveBatchRow[] = batches.map((batch) => {
      const reading = readings.get(batch.batchId) ?? null;
      return {
        ...batch,
        reading,
        writable: archiveBatchWritable(batch.profileName, catalogueProfileName, reading?.state ?? null),
      };
    });
    const { candidates, candidatesError } = await this.candidates(row, catalogueProfileName, batches);
    return { catalogueProfileName, batches: rows, candidates, candidatesError, revision, lastPush };
  }

  async adopt(batchIdInput: string, adopt: ArchiveBatchAdopt, username: string): Promise<ArchiveBatchesAnswer> {
    const batchId = normalBatchId(batchIdInput);
    const labelProblem = archiveLabelProblem(adopt.label);
    if (labelProblem) throw new ArchiveBatchRefusedError(labelProblem);
    const label = adopt.label === null ? null : adopt.label.trim();

    if ((await this.deps.store.revision()) !== adopt.expectedRevision) throw new ManagerSettingsChangedError();
    const row = await this.deps.designation.read();
    if (!isDesignated(row)) throw new ArchiveBatchRefusedError(ARCHIVE_NO_CATALOGUE_NODE_REFUSAL);
    const existing = await this.deps.store.list();
    const context = {
      batchId,
      catalogueBatchIds: catalogueBatchIdsOf(row),
      archiveBatchIds: existing.map((batch) => batch.batchId),
    };
    // Refused by what the manager holds before the node is asked.
    if (context.archiveBatchIds.includes(batchId)) throw new ArchiveBatchRefusedError(ARCHIVE_ALREADY_REFUSAL);
    if (context.catalogueBatchIds.includes(batchId)) {
      throw new ArchiveBatchRefusedError(archiveIsCatalogueBatchRefusal(batchId));
    }

    let stamp: BeeStamp;
    try {
      stamp = await this.deps.heldBatch(row.profileName, batchId);
    } catch (err) {
      throw new ArchiveBatchRefusedError(
        err instanceof StampNotFoundError ? ARCHIVE_NOT_HELD_REFUSAL : ARCHIVE_UNREACHABLE_REFUSAL,
      );
    }
    const problem = archiveBatchProblem(stamp, context);
    if (problem) throw new ArchiveBatchRefusedError(problem);

    const written = await this.designate(
      { batchId, profileName: row.profileName, label, designatedBy: username, purchaseRequestId: null },
      adopt.expectedRevision,
    );
    if (written.outcome === 'changed') throw new ManagerSettingsChangedError();
    if (written.outcome === 'conflict') throw new ArchiveBatchRefusedError(ARCHIVE_ALREADY_REFUSAL);
    return this.read();
  }

  /**
   * Takes an expired batch off the list. The batch is read from its node now: one with life left keeps its place,
   * since the admin would call its recordings lost while they are still on the network, and so does one whose node
   * did not answer. A batch whose deployment is gone has no node to ask and is taken off.
   */
  async remove(batchIdInput: string, remove: ArchiveBatchRemove, username: string): Promise<ArchiveBatchesAnswer> {
    const batchId = normalBatchId(batchIdInput);
    if ((await this.deps.store.revision()) !== remove.expectedRevision) throw new ManagerSettingsChangedError();
    const batch = (await this.deps.store.list()).find((candidate) => candidate.batchId === batchId);
    if (!batch) throw new ArchiveBatchNotFoundError(batchId);

    const state = await this.stateNow(batch);
    // A batch whose deployment is gone has no node to ask, and is taken off.
    const problem = state === null ? null : archiveRemoveProblem(state);
    if (problem) throw new ArchiveBatchRefusedError(problem);

    const written = await this.deps.store.remove(batchId, remove.expectedRevision);
    if (written.outcome === 'changed') throw new ManagerSettingsChangedError();
    if (written.outcome === 'conflict') throw new ArchiveBatchNotFoundError(batchId);
    const why = state === null ? 'its deployment is gone' : `the batch is ${state}`;
    logger.info(
      `[Archive] ${username} removed archive batch ${shortHex(batchId)} on ${batch.profileName}, as ${why}, now at revision ${written.revision}`,
    );
    this.deps.changed();
    return this.read();
  }

  /**
   * Makes a batch an archive batch: what the funding API calls once a purchase is confirmed. A batch that is an archive
   * batch already, or a purchase recorded already, changes nothing and resolves, without a push. Rejects only when the
   * row could not be written.
   */
  async designateArchiveBatch(batch: ArchiveBatchToDesignate): Promise<void> {
    await this.designate(batch, null);
  }

  /** Whether a batch is an archive batch: the catalogue designation refuses one. */
  async isArchiveBatch(batchId: string): Promise<boolean> {
    const id = batchId.replace(/^0x/, '').toLowerCase();
    return (await this.deps.store.list()).some((batch) => batch.batchId === id);
  }

  /**
   * Writes the row, at the revision an operator read or, for a purchase, at whatever revision, and pushes the
   * catalogue stamp record once a row was written. The one way a batch becomes an archive batch.
   */
  private async designate(batch: ArchiveBatchToDesignate, expectedRevision: number | null): Promise<ArchiveBatchWrite> {
    const batchId = normalBatchId(batch.batchId);
    const label = batch.label === null ? null : batch.label.trim() || null;
    const purchaseRequestId = batch.purchaseRequestId === null ? null : batch.purchaseRequestId.toLowerCase();
    const written = await this.deps.store.designate(
      {
        batchId,
        profileName: batch.profileName,
        label,
        source: purchaseRequestId === null ? 'adopted' : 'purchase',
        purchaseRequestId,
        designatedAt: new Date(this.now()).toISOString(),
        designatedBy: batch.designatedBy,
      },
      expectedRevision,
    );
    if (written.outcome !== 'saved') return written;
    const how =
      purchaseRequestId === null
        ? `adopted by ${batch.designatedBy ?? 'nobody named'}`
        : `bought by request ${purchaseRequestId}`;
    logger.info(
      `[Archive] batch ${shortHex(batchId)} on ${batch.profileName}, ${how}, is an archive batch, now at revision ${written.revision}`,
    );
    this.deps.changed();
    return written;
  }

  /**
   * The batch's state on its node now, asked fresh, `unknown` when the node did not answer, and null when its
   * deployment is gone.
   */
  private async stateNow(batch: ArchiveBatchDesignation): Promise<StampState | null> {
    try {
      const stamp = await this.deps.heldBatch(batch.profileName, batch.batchId);
      return stampHealthFrom(batch.batchId, [stamp]).state;
    } catch (err) {
      if (err instanceof ProfileNotFoundError) return null;
      if (err instanceof StampNotFoundError) return 'gone';
      logger.warn(
        `[Archive] reading batch ${shortHex(batch.batchId)} for its removal failed (${getErrorMessage(err)})`,
      );
      return 'unknown';
    }
  }

  /** The other batches the catalogue node holds, each with why it cannot be adopted, or why none could be read. */
  private async candidates(
    row: CatalogueDesignationRow,
    catalogueProfileName: string | null,
    batches: readonly ArchiveBatchDesignation[],
  ): Promise<{ candidates: ArchiveBatchCandidate[]; candidatesError: string | null }> {
    if (catalogueProfileName === null) return { candidates: [], candidatesError: null };
    const archiveBatchIds = batches.map((batch) => batch.batchId);
    const catalogueBatchIds = catalogueBatchIdsOf(row);
    let stamps: BeeStamp[];
    try {
      stamps = await this.deps.listStamps(catalogueProfileName);
    } catch (err) {
      logger.warn(`[Archive] listing the catalogue node's batches failed (${getErrorMessage(err)})`);
      return { candidates: [], candidatesError: ARCHIVE_UNREACHABLE_REFUSAL };
    }
    const candidates: ArchiveBatchCandidate[] = [];
    for (const stamp of stamps) {
      if (!BATCH_ID_RE.test(stamp.batchID)) continue;
      const batchId = normalBatchId(stamp.batchID);
      if (archiveBatchIds.includes(batchId)) continue;
      candidates.push({
        batchId,
        nodeLabel: typeof stamp.label === 'string' && stamp.label !== '' ? stamp.label : null,
        depth: Number.isInteger(stamp.depth) ? stamp.depth : null,
        immutable: typeof stamp.immutableFlag === 'boolean' ? stamp.immutableFlag : null,
        ttlSeconds: Number.isFinite(stamp.batchTTL) ? stamp.batchTTL : null,
        problem: archiveBatchProblem(stamp, { batchId, catalogueBatchIds, archiveBatchIds }),
      });
    }
    return { candidates, candidatesError: null };
  }
}

/** A batch id in the form the table keeps: 64 hex digits, lower case, no `0x`. Refuses any other spelling. */
function normalBatchId(input: string): string {
  if (!BATCH_ID_RE.test(input)) throw new ArchiveBatchRefusedError('A batch id is 64 hex digits, with or without 0x.');
  return input.replace(/^0x/, '').toLowerCase();
}

/** The catalogue's own batches: the pinned one, designated or cleared since, and the one a pending move left. */
function catalogueBatchIdsOf(row: CatalogueDesignationRow): string[] {
  return [row.batchId, row.movingFromBatchId].filter((id): id is string => id !== null);
}
