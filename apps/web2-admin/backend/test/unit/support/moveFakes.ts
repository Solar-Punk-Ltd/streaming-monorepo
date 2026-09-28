/**
 * In-memory stand-ins for what moving the catalogue reads and writes: the feed write log with the restamp columns of
 * migration 014, and `catalogue_moves`, with the same conditional updates the SQL makes. The integration suite
 * `catalogueMoves.test.ts` holds the SQL to the same answers.
 */
import type {
  CatalogueMoveRow,
  CatalogueMoveStore,
  FeedSlotRow,
  SlotCounts,
} from '../../../src/domain/CatalogueMoveRepository.js';
import type { FeedWriteRecord } from '../../../src/domain/FeedWriteRepository.js';
import type { FeedWriteLog } from '../../../src/domain/PublishService.js';

interface Written extends FeedWriteRecord {
  restampedBatchId: string | null;
}

/** `feed_writes`, as PublishService writes it and the move reads and marks it. */
export class FakeFeedWrites implements FeedWriteLog {
  readonly rows: Written[] = [];

  async record(write: FeedWriteRecord): Promise<void> {
    this.rows.push({ ...structuredClone(write), restampedBatchId: null });
  }

  async lastWrite(owner: string, topic: string): Promise<{ index: number; entries: unknown[] } | null> {
    const mine = this.rows.filter((row) => row.owner === owner && row.topic === topic);
    if (mine.length === 0) return null;
    const last = mine.reduce((a, b) => (b.feedIndex > a.feedIndex ? b : a));
    return { index: last.feedIndex, entries: structuredClone(last.payload) };
  }

  async countUnrecordedBatch(owner: string, topic: string): Promise<number> {
    return this.rows.filter((row) => row.owner === owner && row.topic === topic && row.batchId === null).length;
  }

  of(owner: string, topic: string, from: number, to: number): Written[] {
    return this.rows.filter(
      (row) => row.owner === owner && row.topic === topic && row.feedIndex >= from && row.feedIndex <= to,
    );
  }
}

/** `catalogue_moves`, over a FakeFeedWrites for the slot reads and marks. */
export class InMemoryCatalogueMoveStore implements CatalogueMoveStore {
  readonly moves: (CatalogueMoveRow & { owner: string; topic: string })[] = [];
  private sequence = 0;
  /** Set to make the next `recordSlot` fail, as a lost connection would. */
  failNextRecord: Error | null = null;

  constructor(readonly writes: FakeFeedWrites) {}

  async latest(owner: string, topic: string): Promise<CatalogueMoveRow | null> {
    const mine = this.moves.filter((move) => move.owner === owner && move.topic === topic);
    return mine.length === 0 ? null : this.copy(mine[mine.length - 1]!);
  }

  async coveredBelow(owner: string, topic: string, targetBatchId: string): Promise<number> {
    const done = this.moves.filter(
      (move) =>
        move.owner === owner && move.topic === topic && move.targetBatchId === targetBatchId && move.state === 'done',
    );
    return done.reduce((most, move) => Math.max(most, move.nextIndex), 0);
  }

  async slotCounts(owner: string, topic: string, targetBatchId: string, from: number, to: number): Promise<SlotCounts> {
    const rows = this.writes.of(owner, topic, from, to);
    const under = (row: Written) => row.batchId === targetBatchId || row.restampedBatchId === targetBatchId;
    return {
      underTarget: rows.filter(under).length,
      readable: rows.filter((row) => row.payloadText !== null || under(row)).length,
    };
  }

  async slots(owner: string, topic: string, from: number, to: number): Promise<FeedSlotRow[]> {
    return this.writes
      .of(owner, topic, from, to)
      .sort((a, b) => a.feedIndex - b.feedIndex)
      .map((row) => ({
        index: row.feedIndex,
        payloadText: row.payloadText,
        batchId: row.batchId,
        restampedBatchId: row.restampedBatchId,
        reference: row.reference,
      }));
  }

  async create(move: {
    owner: string;
    topic: string;
    targetBatchId: string;
    fromBatchId: string | null;
    startedBy: string;
  }): Promise<CatalogueMoveRow | null> {
    if (this.moves.some((m) => m.owner === move.owner && m.topic === move.topic && m.state === 'running')) return null;
    this.sequence += 1;
    const at = new Date();
    const row = {
      id: String(this.sequence),
      owner: move.owner,
      topic: move.topic,
      targetBatchId: move.targetBatchId,
      fromBatchId: move.fromBatchId,
      state: 'running' as const,
      nextIndex: 0,
      headIndex: null,
      restampedSlots: 0,
      skippedSlots: 0,
      thumbnails: 0,
      error: null,
      startedBy: move.startedBy,
      startedAt: at,
      updatedAt: at,
      finishedAt: null,
    };
    this.moves.push(row);
    return this.copy(row);
  }

  async retry(id: string): Promise<CatalogueMoveRow | null> {
    const move = this.find(id);
    if (!move || move.state !== 'failed') return null;
    if (this.moves.some((m) => m.owner === move.owner && m.topic === move.topic && m.state === 'running')) return null;
    Object.assign(move, { state: 'running', error: null, finishedAt: null, updatedAt: new Date() });
    return this.copy(move);
  }

  async recordSlot(
    id: string,
    slot: { owner: string; topic: string; index: number; restamped: boolean; head: number },
  ): Promise<CatalogueMoveRow | null> {
    if (this.failNextRecord) {
      const failure = this.failNextRecord;
      this.failNextRecord = null;
      throw failure;
    }
    const move = this.find(id);
    if (!move || move.state !== 'running' || move.nextIndex !== slot.index) return null;
    move.nextIndex += 1;
    move.headIndex = Math.max(move.headIndex ?? 0, slot.head);
    if (slot.restamped) move.restampedSlots += 1;
    else move.skippedSlots += 1;
    move.updatedAt = new Date();
    if (slot.restamped) {
      for (const row of this.writes.of(slot.owner, slot.topic, slot.index, slot.index)) {
        row.restampedBatchId = move.targetBatchId;
      }
    }
    return this.copy(move);
  }

  async finish(id: string, thumbnails: number): Promise<CatalogueMoveRow | null> {
    const move = this.find(id);
    if (!move || move.state !== 'running') return null;
    Object.assign(move, { state: 'done', thumbnails, finishedAt: new Date(), updatedAt: new Date() });
    return this.copy(move);
  }

  async fail(id: string, error: string): Promise<CatalogueMoveRow | null> {
    const move = this.find(id);
    if (!move || move.state !== 'running') return null;
    Object.assign(move, { state: 'failed', error, finishedAt: new Date(), updatedAt: new Date() });
    return this.copy(move);
  }

  private find(id: string) {
    return this.moves.find((move) => move.id === id);
  }

  private copy(move: CatalogueMoveRow & { owner: string; topic: string }): CatalogueMoveRow {
    const { owner: _owner, topic: _topic, ...row } = move;
    return structuredClone(row);
  }
}

/** Where the move finds a thumbnail's stored bytes: a map by reference. */
export class FakeThumbnailStore {
  readonly byRef = new Map<string, { thumbnail: Buffer; thumbnail_mime: string | null; topic: string }>();

  async findThumbnailByRef(
    reference: string,
  ): Promise<{ thumbnail: Buffer; thumbnail_mime: string | null; topic: string } | null> {
    return this.byRef.get(reference) ?? null;
  }
}
