import type { ArchiveBatchDesignation } from '@streaming-infra-manager/common';

import type { ArchiveBatchStore, ArchiveBatchWrite } from '../../src/domain/stages/ArchiveBatchRepository.js';

/** The archive batches as migration 054's tables hold them, in memory, with the revision guard and the unique keys. */
export class InMemoryArchiveBatches implements ArchiveBatchStore {
  rows: ArchiveBatchDesignation[] = [];
  currentRevision = 0;

  async list(): Promise<ArchiveBatchDesignation[]> {
    return [...this.rows]
      .sort((a, b) => a.designatedAt.localeCompare(b.designatedAt) || a.batchId.localeCompare(b.batchId))
      .map((row) => ({ ...row }));
  }

  async revision(): Promise<number> {
    return this.currentRevision;
  }

  async designate(designation: ArchiveBatchDesignation, expectedRevision: number | null): Promise<ArchiveBatchWrite> {
    if (expectedRevision !== null && expectedRevision !== this.currentRevision) return { outcome: 'changed' };
    if (!this.insert(designation)) return { outcome: 'conflict' };
    this.currentRevision += 1;
    return { outcome: 'saved', revision: this.currentRevision };
  }

  async remove(batchId: string, expectedRevision: number): Promise<ArchiveBatchWrite> {
    if (expectedRevision !== this.currentRevision) return { outcome: 'changed' };
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.batchId !== batchId);
    if (this.rows.length === before) return { outcome: 'conflict' };
    this.currentRevision += 1;
    return { outcome: 'saved', revision: this.currentRevision };
  }

  async recordDepth(batchId: string, depth: number): Promise<void> {
    const row = this.rows.find((entry) => entry.batchId === batchId);
    if (row) row.depth = depth;
  }

  private insert(designation: ArchiveBatchDesignation): boolean {
    const taken = this.rows.some(
      (row) =>
        row.batchId === designation.batchId ||
        (designation.purchaseRequestId !== null && row.purchaseRequestId === designation.purchaseRequestId),
    );
    if (taken) return false;
    this.rows.push({ ...designation });
    return true;
  }
}
