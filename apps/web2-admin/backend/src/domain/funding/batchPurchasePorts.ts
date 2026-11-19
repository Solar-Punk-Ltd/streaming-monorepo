import type { BatchPurchaseMove } from '@streaming-monorepo/web2-admin-common';

/**
 * The seam between a batch purchase of the Stamps tab and the move of the catalogue. The purchase, its table, its
 * routes and its calls to the manager are one part of the admin. The move of the catalogue onto another batch is
 * another, which the Stages page already drives. Each is built against this port and tested with a fake of the other
 * side. `docs/architecture/stages.md`, "A batch bought on the Stamps tab", is the page.
 *
 * The catalogue move implements {@link PurchasedCatalogueMove}. The purchase calls it, and implements nothing here.
 *
 * A batch id here is 64 hex digits without `0x`, in lower case, as the admin keeps one.
 */

/** The move of the catalogue onto a bought batch, as the purchase reads it. `released` is the purchase's own to say. */
export type PurchasedMoveReading = Omit<BatchPurchaseMove, 'released'>;

/** What a catalogue purchase asks of the catalogue move. */
export interface PurchasedCatalogueMove {
  /** Whether the move is switched on on this installation, `CATALOGUE_MOVE_ENABLED`. Off, the tab offers no purchase. */
  enabled(): boolean;

  /**
   * Makes sure the move onto `targetBatchId` runs, for the purchase that bought it, and answers where it stands. It
   * starts the move once the manager's catalogue stamp record designates that batch, as the system, with the purchase
   * named as its starter; it starts a failed one again from where it stopped when `retryFailed` is set; and it changes
   * nothing for a move that runs or is done. Before the record names the batch, and while a start is refused, it
   * answers `waiting` with the refusal's sentence, and the purchase asks again at its next turn.
   *
   * After a lapse of the batch moved from, the move clears a thumbnail it can read from nowhere and lists its stream,
   * where a move from a batch with time left stops.
   */
  ensure(input: { targetBatchId: string; purchaseId: string; retryFailed: boolean }): Promise<PurchasedMoveReading>;
}
