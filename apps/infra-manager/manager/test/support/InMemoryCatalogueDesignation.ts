import type {
  CatalogueDesignationRow,
  CatalogueDesignationStore,
  CatalogueDesignationWrite,
} from '../../src/domain/stages/CatalogueDesignationRepository.js';

/** The catalogue designation as its single-row table holds it, in memory, with the table's revision guard. */
export class InMemoryCatalogueDesignation implements CatalogueDesignationStore {
  row: CatalogueDesignationRow = {
    profileName: null,
    batchId: null,
    batchDepth: null,
    designatedAt: null,
    designatedBy: null,
    clearedAt: null,
    revision: 0,
  };

  async read(): Promise<CatalogueDesignationRow> {
    return { ...this.row };
  }

  async designate(
    write: CatalogueDesignationWrite,
    expectedRevision: number,
    username: string,
  ): Promise<CatalogueDesignationRow | null> {
    if (expectedRevision !== this.row.revision) return null;
    this.row = {
      ...this.row,
      profileName: write.profileName,
      batchId: write.batchId,
      batchDepth: write.batchDepth,
      designatedAt: write.at,
      designatedBy: username,
      revision: this.row.revision + 1,
    };
    return { ...this.row };
  }

  async clear(at: Date, expectedRevision: number, username: string): Promise<CatalogueDesignationRow | null> {
    if (expectedRevision !== this.row.revision) return null;
    this.row = {
      ...this.row,
      profileName: null,
      batchId: null,
      batchDepth: null,
      designatedAt: null,
      designatedBy: username,
      clearedAt: at,
      revision: this.row.revision + 1,
    };
    return { ...this.row };
  }
}
