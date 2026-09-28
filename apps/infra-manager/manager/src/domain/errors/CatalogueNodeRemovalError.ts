/** The designated catalogue node is not removed while it is designated: the brand's catalogue is written through it. */
export class CatalogueNodeRemovalError extends Error {
  constructor(readonly profileName: string) {
    super(
      `${profileName} is the brand's catalogue node, and the web2 admin writes the catalogue through it. Clear the designation on the Manager settings page before removing it.`,
    );
    this.name = 'CatalogueNodeRemovalError';
  }
}
