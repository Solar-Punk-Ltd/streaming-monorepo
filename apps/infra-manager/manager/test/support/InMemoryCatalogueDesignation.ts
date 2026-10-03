import type {
  CatalogueDesignationRow,
  CatalogueDesignationStore,
  CatalogueDesignationWrite,
} from '../../src/domain/stages/CatalogueDesignationRepository.js';

/** The row before anything is designated, as migrations 047 and 048 leave it. */
export function emptyCatalogueDesignationRow(): CatalogueDesignationRow {
  return {
    profileName: null,
    batchId: null,
    batchDepth: null,
    designatedAt: null,
    designatedBy: null,
    clearedAt: null,
    movingFromProfileName: null,
    movingFromBatchId: null,
    movingFromBatchDepth: null,
    moveStartedAt: null,
    moveStartedBy: null,
    releasedAt: null,
    releasedBy: null,
    revision: 0,
  };
}

/** The catalogue designation as its single-row table holds it, in memory, with the table's revision guard. */
export class InMemoryCatalogueDesignation implements CatalogueDesignationStore {
  row: CatalogueDesignationRow = emptyCatalogueDesignationRow();

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
      clearedAt: null,
      revision: this.row.revision + 1,
    };
    return { ...this.row };
  }

  async move(
    write: CatalogueDesignationWrite,
    expectedRevision: number,
    username: string,
  ): Promise<CatalogueDesignationRow | null> {
    const { row } = this;
    if (expectedRevision !== row.revision || row.batchId === null || row.batchId === write.batchId) return null;
    if (row.movingFromBatchId !== null && row.movingFromBatchId !== write.batchId) return null;
    this.row = {
      ...row,
      movingFromProfileName: row.profileName,
      movingFromBatchId: row.batchId,
      movingFromBatchDepth: row.batchDepth,
      moveStartedAt: write.at,
      moveStartedBy: username,
      profileName: write.profileName,
      batchId: write.batchId,
      batchDepth: write.batchDepth,
      designatedAt: write.at,
      designatedBy: username,
      clearedAt: null,
      revision: row.revision + 1,
    };
    return { ...this.row };
  }

  async clear(at: Date, expectedRevision: number, username: string): Promise<CatalogueDesignationRow | null> {
    if (expectedRevision !== this.row.revision || this.row.profileName === null) return null;
    this.row = {
      ...this.row,
      designatedBy: username,
      clearedAt: at,
      revision: this.row.revision + 1,
    };
    return { ...this.row };
  }

  async release(at: Date, expectedRevision: number, username: string): Promise<CatalogueDesignationRow | null> {
    if (expectedRevision !== this.row.revision || this.row.movingFromBatchId === null) return null;
    this.row = {
      ...this.row,
      movingFromProfileName: null,
      movingFromBatchId: null,
      movingFromBatchDepth: null,
      moveStartedAt: null,
      moveStartedBy: null,
      releasedAt: at,
      releasedBy: username,
      revision: this.row.revision + 1,
    };
    return { ...this.row };
  }
}
