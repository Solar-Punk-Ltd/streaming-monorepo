import type { ArchiveBatchDesignation } from '@streaming-infra-manager/common';

/**
 * The seam between the archive batches and the funding API. The archive batches, their table, their settings routes
 * and the catalogue stamp record's `archiveBatches` are one part of the manager; the funding API's inventory, stamp
 * operations and stamp purchases are another. Each is built against these three ports, and tested with a fake of the
 * other side. `docs/features/stages.md`, "Archive batches", and the API reference, "Stamp purchases", are the pages.
 *
 * The archive batches implement {@link ArchiveBatchReader} and {@link ArchivePurchaseRecorder}. The funding API calls
 * them, and implements nothing here.
 */

/** What the funding API reads of the archive batches. */
export interface ArchiveBatchReader {
  /**
   * Every archive batch, in the order they were designated. The inventory lists them on the catalogue node, each with
   * the readings it takes itself and `writable` true for one whose `profileName` is the designated catalogue node. A
   * stamp operation on the catalogue node takes a batch only when it is one of these or the catalogue's own.
   */
  list(): Promise<ArchiveBatchDesignation[]>;
}

/** A batch a purchase bought, as the funding API hands it over once the node answered or the purchase was settled. */
export interface PurchasedArchiveBatch {
  /** The batch, 64 hex digits without `0x`, in lower case, as `archive_batches.batch_id` keeps one. */
  batchId: string;
  /** The deployment whose Bee node bought it: the catalogue node the purchase named. */
  profileName: string;
  /** The name the request gave it, or null. */
  label: string | null;
  /** The funding API request that bought it. */
  purchaseRequestId: string;
}

/** What the funding API tells the archive batches. */
export interface ArchivePurchaseRecorder {
  /**
   * Records a bought batch as an archive batch, with source `purchase`, raises the revision and pushes the catalogue
   * stamp record. Called once a purchase is `confirmed`, from the `POST` and from the `GET` that settles one. The same
   * `purchaseRequestId` again changes nothing and resolves, so a settle that runs twice records one row. It rejects
   * only when the row could not be written, and the purchase then stays `confirmed`: the next `GET` calls it again.
   */
  recordPurchase(batch: PurchasedArchiveBatch): Promise<void>;
}
