import type { FundingPurchaseStep, FundingTransferState } from '@streaming-monorepo/contracts';

import type {
  FundingPurchaseStagePatch,
  FundingPurchaseStageRow,
  FundingPurchaseStepPatch,
  FundingStampPurchaseInsert,
  FundingStampPurchaseJournal,
  FundingStampPurchasePatch,
  FundingStampPurchaseRow,
} from '../../src/domain/funding/FundingStampPurchaseJournal.js';

/**
 * Whether a purchase is still under way on its node, being bought or waiting for its batch to become usable, of which
 * migration 056's index holds one per node.
 */
function isOpen(row: Pick<FundingStampPurchaseRow, 'state' | 'step'>): boolean {
  return row.state === 'unknown' || row.state === 'submitted' || row.step === 'waiting_usable';
}

/**
 * The batch purchase journal in memory, with the tables' rules the service and its follow-up lean on: a request id is
 * journalled once, a node label belongs to one purchase, a node has one purchase under way at a time, an update lands
 * only on a row still in the state or at the step it names, an archive stamp's row is marked recorded once, and a
 * purchase's stages are written once each, in their order.
 */
export class InMemoryFundingStampPurchaseJournal implements FundingStampPurchaseJournal {
  readonly rows = new Map<string, FundingStampPurchaseRow>();
  /** Each purchase's stages, by request id, in the order of their position. */
  readonly stages = new Map<string, FundingPurchaseStageRow[]>();

  async find(requestId: string): Promise<FundingStampPurchaseRow | null> {
    const row = this.rows.get(requestId);
    return row ? { ...row } : null;
  }

  async openOn(nodeId: string): Promise<FundingStampPurchaseRow | null> {
    const open = [...this.rows.values()].find((row) => row.nodeId === nodeId && isOpen(row));
    return open ? { ...open } : null;
  }

  async insert(row: FundingStampPurchaseRow): Promise<FundingStampPurchaseInsert> {
    if (this.rows.has(row.requestId)) return 'request_taken';
    const others = [...this.rows.values()];
    if (isOpen(row) && others.some((each) => each.nodeId === row.nodeId && isOpen(each))) return 'node_busy';
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

  async advance(requestId: string, from: FundingPurchaseStep, patch: FundingPurchaseStepPatch): Promise<boolean> {
    const row = this.rows.get(requestId);
    if (!row || row.step !== from) return false;
    this.rows.set(requestId, { ...row, ...patch });
    return true;
  }

  async markRecorded(requestId: string, at: Date): Promise<boolean> {
    const row = this.rows.get(requestId);
    if (!row || row.purpose !== 'archive' || row.state !== 'confirmed' || row.recordedAt !== null) return false;
    this.rows.set(requestId, { ...row, recordedAt: at });
    return true;
  }

  async unrecorded(): Promise<FundingStampPurchaseRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.purpose === 'archive' && row.state !== 'failed' && row.recordedAt === null)
      .map((row) => ({ ...row }));
  }

  async following(): Promise<FundingStampPurchaseRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.step === 'buying' || row.step === 'waiting_usable' || row.step === 'set')
      .map((row) => ({ ...row }));
  }

  async stagesOf(requestId: string): Promise<FundingPurchaseStageRow[]> {
    return (this.stages.get(requestId) ?? []).map((stage) => ({ ...stage }));
  }

  async addStages(requestId: string, stages: readonly FundingPurchaseStageRow[]): Promise<void> {
    const kept = this.stages.get(requestId) ?? [];
    for (const stage of stages) {
      if (kept.some((each) => each.stageId === stage.stageId || each.position === stage.position)) continue;
      kept.push({ ...stage });
    }
    this.stages.set(
      requestId,
      kept.sort((a, b) => a.position - b.position),
    );
  }

  async updateStage(requestId: string, stageId: string, patch: FundingPurchaseStagePatch): Promise<void> {
    const kept = this.stages.get(requestId) ?? [];
    this.stages.set(
      requestId,
      kept.map((stage) =>
        stage.stageId === stageId
          ? {
              ...stage,
              apply: patch.apply,
              message: patch.message,
              updatedAt: patch.updatedAt,
              forcedAt: patch.forcedAt ?? stage.forcedAt,
            }
          : stage,
      ),
    );
  }
}
