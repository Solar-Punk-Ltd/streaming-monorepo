/**
 * The catalogue node is not removed while the catalogue is pinned to it, and the node of the batch the catalogue is
 * moving from is not removed until that batch is released: the brand's catalogue is written through the one and its
 * history lives on the other.
 */
export class CatalogueNodeRemovalError extends Error {
  constructor(
    readonly profileName: string,
    /** Whether the deployment holds the batch the catalogue is moving from, rather than the pinned one. */
    readonly movingFrom = false,
  ) {
    super(
      movingFrom
        ? `${profileName} holds the batch the brand's catalogue is moving from, which keeps the catalogue's history until the web2 admin reports the move done. Release the previous batch on the Manager settings page before removing it.`
        : `${profileName} is the brand's catalogue node, and the web2 admin writes the catalogue through it. Clear the designation on the Manager settings page before removing it.`,
    );
    this.name = 'CatalogueNodeRemovalError';
  }
}
