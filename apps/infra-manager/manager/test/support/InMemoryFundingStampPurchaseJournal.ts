import type { FundingTransferState } from '@streaming-monorepo/contracts';

import type {
  FundingStampPurchaseInsert,
  FundingStampPurchaseJournal,
  FundingStampPurchasePatch,
  FundingStampPurchaseRow,
} from '../../src/domain/funding/FundingStampPurchaseJournal.js';

/** Whether a purchase is still being settled, the states migration 055 holds one of per node. */
function isOpen(state: FundingTransferState): boolean {
  return state === 'unknown' || state === 'submitted';
}

/**
 * The stamp purchase journal in memory, with the table's rules the service leans on: a request id is journalled once,
 * a node label belongs to one purchase, a node has one purchase still being settled at a time, an update lands only on
 * a row still in the state it names, and a confirmed row is marked recorded once.
 */
export class InMemoryFundingStampPurchaseJournal implements FundingStampPurchaseJournal {
  readonly rows = new Map<string, FundingStampPurchaseRow>();

  async find(requestId: string): Promise<FundingStampPurchaseRow | null> {
    const row = this.rows.get(requestId);
    return row ? { ...row } : null;
  }

  async openOn(nodeId: string): Promise<FundingStampPurchaseRow | null> {
    const open = [...this.rows.values()].find((row) => row.nodeId === nodeId && isOpen(row.state));
    return open ? { ...open } : null;
  }

  async insert(row: FundingStampPurchaseRow): Promise<FundingStampPurchaseInsert> {
    if (this.rows.has(row.requestId)) return 'request_taken';
    const others = [...this.rows.values()];
    if (isOpen(row.state) && others.some((each) => each.nodeId === row.nodeId && isOpen(each.state))) {
      return 'node_busy';
    }
    if (others.some((each) => each.nodeLabel === row.nodeLabel)) return 'label_taken';
    this.rows.set(row.requestId, { ...row });
    return 'inserted';
  }

  async update(requestId: string, from: FundingTransferState, patch: FundingStampPurchasePatch): Promise<boolean> {
    const row = this.rows.get(requestId);
    if (!row || row.state !== from) return false;
    this.rows.set(requestId, { ...row, ...patch });
    return true;
  }

  async markRecorded(requestId: string, at: Date): Promise<boolean> {
    const row = this.rows.get(requestId);
    if (!row || row.state !== 'confirmed' || row.recordedAt !== null) return false;
    this.rows.set(requestId, { ...row, recordedAt: at });
    return true;
  }

  async unrecorded(): Promise<FundingStampPurchaseRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.state !== 'failed' && row.recordedAt === null)
      .map((row) => ({ ...row }));
  }
}
