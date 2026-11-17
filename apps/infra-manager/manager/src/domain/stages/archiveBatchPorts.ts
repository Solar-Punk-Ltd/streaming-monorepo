import type { ArchiveBatchDesignation } from '@streaming-infra-manager/common';

/**
 * The seam between the archive batches and the funding API. The archive batches, their table, their settings routes
 * and the catalogue stamp record's `archiveBatches` are one part of the manager; the funding API's inventory, stamp
 * operations and stamp purchases are another. Each is built against these two ports, and tested with a fake of the
 * other side. `docs/features/stages.md`, "Archive batches", and the API reference, "Stamp purchases", are the pages.
 *
 * The archive batches implement {@link ArchiveBatchReader} and {@link ArchiveBatchDesignator}. The funding API calls
 * them, and implements nothing here.
 */

/** What the funding API reads of the archive batches. */
export interface ArchiveBatchReader {
  /**
   * Every archive batch, in the order they were designated. The inventory lists them in `archiveBatches`, each with
   * the node of its `profileName` as its holder and the readings the inventory takes itself, and `writable` true only
   * for a usable, unexpired one on the designated catalogue node. A stamp operation takes an archive batch with the
   * node that holds it. A settle of a purchase with a lost answer skips every batch listed here.
   */
  list(): Promise<ArchiveBatchDesignation[]>;
}

/** A batch to make an archive batch, as `designateArchiveBatch` takes it. */
export interface ArchiveBatchToDesignate {
  /** The batch, 64 hex digits without `0x`, in lower case, as `archive_batches.batch_id` keeps one. */
  batchId: string;
  /** The deployment whose Bee node holds it: the catalogue node a purchase named, or the one an adopt was made on. */
  profileName: string;
  /** Its depth: the one the purchase bought, or the one the node reported at an adopt. 17 to 64. */
  depth: number;
  /** The name it was given, or null. */
  label: string | null;
  /** Who designated it: the operator who adopted it, or null for a purchase, which the admin's audit log names. */
  designatedBy: string | null;
  /** The funding API request that bought it, or null for an adopted one. */
  purchaseRequestId: string | null;
}

/** What the funding API tells the archive batches, and what the settings route's adopt runs through too. */
export interface ArchiveBatchDesignator {
  /**
   * Makes a batch an archive batch: writes its row, raises the revision and pushes the catalogue stamp record. The
   * funding API calls it once a purchase is `confirmed`, from the `POST` and from the `GET` that settles one. It is
   * idempotent on `batchId`: a batch that is an archive batch already changes nothing and resolves, without a second
   * push, so a settle that runs twice records one row. It rejects when the row could not be written, and the purchase
   * then stays `confirmed`: the next `GET` calls it again. It rejects too, with `ArchiveBatchRefusedError`, for a
   * batch that is the catalogue's own, pinned or left by a pending move, since a batch is never both; the purchase
   * stays `confirmed` and unrecorded then as well.
   */
  designateArchiveBatch(batch: ArchiveBatchToDesignate): Promise<void>;
}
