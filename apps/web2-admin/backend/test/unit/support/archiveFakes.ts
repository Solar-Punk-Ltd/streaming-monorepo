import { randomBytes } from 'node:crypto';

import { Bytes, FeedIndex, Topic } from '@ethersphere/bee-js';
import type { CatalogueArchiveBatch, CatalogueStampRecord } from '@streaming-monorepo/contracts';
import type { ArchiveJobState } from '@streaming-monorepo/web2-admin-common';

import {
  ArchiveNodeError,
  ChunkMissingError,
  type ArchiveNode,
  type SocPost,
  type TagReading,
} from '../../../src/domain/archive/ArchiveNode.js';
import type {
  ArchiveItemChange,
  ArchiveItemRow,
  ArchiveJobChange,
  ArchiveJobRow,
  ArchiveJobView,
  ArchivePurchaseRow,
  ArchiveSegmentDone,
  ArchiveStore,
  NewArchiveJob,
  NewPurchase,
  NewStreamArchive,
  PlaceRefusal,
  PurchaseChange,
  StreamArchiveChange,
  StreamArchiveRow,
} from '../../../src/domain/archive/ArchiveRepository.js';
import {
  BRANCHES,
  CHUNK_PAYLOAD_BYTES,
  chunkAddress,
  maxShards,
  parityCount,
  SOC_HEADER_BYTES,
  type RedundancyLevel,
} from '../../../src/domain/archive/chunkTree.js';
import type { CatalogueStampRow } from '../../../src/types/index.js';

/** Fakes for archiving a recording: chunk trees as Bee builds them, a node that holds them, and the job's store. */

/** A content-addressed chunk: its span, with the erasure level in the top byte when it carries one, and its payload. */
export function cac(payload: Uint8Array, span: number, level: RedundancyLevel = 0): Uint8Array {
  const chunk = new Uint8Array(8 + payload.length);
  Buffer.from(chunk.buffer).writeBigUInt64LE(BigInt(span), 0);
  if (level > 0) chunk[7] = 0x80 | level;
  chunk.set(payload, 8);
  return chunk;
}

export interface BuiltFile {
  root: string;
  chunks: Map<string, Uint8Array>;
  data: string[];
  intermediate: string[];
  parity: string[];
}

/**
 * A file's chunk tree as Bee builds it at `level`: data chunks of 4096 bytes, then intermediates of up to the level's
 * shards, each followed by its group's parity chunks, up to one root. Parity chunks hold random bytes, as coded data
 * looks.
 */
export function buildFile(content: Uint8Array, level: RedundancyLevel = 0): BuiltFile {
  const built: BuiltFile = { root: '', chunks: new Map(), data: [], intermediate: [], parity: [] };
  const put = (chunk: Uint8Array, kind: 'data' | 'intermediate' | 'parity') => {
    const address = chunkAddress(chunk);
    built.chunks.set(address, chunk);
    built[kind].push(address);
    return address;
  };
  let nodes: Array<{ address: string; span: number }> = [];
  for (let at = 0; at < Math.max(content.length, 1); at += CHUNK_PAYLOAD_BYTES) {
    const payload = content.subarray(at, at + CHUNK_PAYLOAD_BYTES);
    nodes.push({ address: put(cac(payload, payload.length), 'data'), span: payload.length });
  }
  const group = level === 0 ? BRANCHES : maxShards(level);
  while (nodes.length > 1) {
    const next: typeof nodes = [];
    for (let at = 0; at < nodes.length; at += group) {
      const shards = nodes.slice(at, at + group);
      const span = shards.reduce((sum, node) => sum + node.span, 0);
      const parity = Array.from({ length: parityCount(level, shards.length) }, () =>
        put(cac(new Uint8Array(randomBytes(CHUNK_PAYLOAD_BYTES)), CHUNK_PAYLOAD_BYTES), 'parity'),
      );
      const refs = Buffer.concat([
        ...shards.map((node) => Buffer.from(node.address, 'hex')),
        ...parity.map((ref) => Buffer.from(ref, 'hex')),
      ]);
      next.push({ address: put(cac(new Uint8Array(refs), span, level), 'intermediate'), span });
    }
    nodes = next;
  }
  built.root = nodes[0]!.address;
  return built;
}

/** The address a feed slot has, and its single-owner chunk wrapping `wrapped`, with a stand-in signature. */
export function buildSlot(
  owner: string,
  topic: string,
  index: number,
  wrapped: Uint8Array,
): { address: string; soc: Uint8Array } {
  const identifier = Bytes.keccak256(
    Bytes.concat(Topic.fromString(topic).toUint8Array(), FeedIndex.fromBigInt(BigInt(index)).toUint8Array()),
  );
  const address = Bytes.keccak256(Bytes.concat(identifier.toUint8Array(), Buffer.from(owner, 'hex'))).toHex();
  const soc = new Uint8Array(SOC_HEADER_BYTES + wrapped.length);
  soc.set(identifier.toUint8Array(), 0);
  soc.set(new Uint8Array(65).fill(7), 32);
  soc.set(wrapped, SOC_HEADER_BYTES);
  return { address, soc };
}

/** A playlist naming `refs`, two seconds each, as the uploader writes a recording's. */
export function playlistText(refs: readonly string[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (const reference of refs) lines.push('#EXTINF:2.000000,', reference);
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

/**
 * A feed slot whose payload is `text`: inline up to 4096 bytes, wrapped in a root above. Its chunks go into `into`.
 * Answers the slot's address, and the wrapped root's when there is one.
 */
export function slotFor(
  owner: string,
  topic: string,
  index: number,
  text: string,
  into: Map<string, Uint8Array>,
): { address: string; root: string | null } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= CHUNK_PAYLOAD_BYTES) {
    const { address, soc } = buildSlot(owner, topic, index, cac(bytes, bytes.length));
    into.set(address, soc);
    return { address, root: null };
  }
  const file = buildFile(bytes);
  for (const [address, chunk] of file.chunks) into.set(address, chunk);
  const { address, soc } = buildSlot(owner, topic, index, file.chunks.get(file.root)!);
  into.set(address, soc);
  return { address, root: file.root };
}

interface FakeTag extends TagReading {
  /** Posts not pushed yet, by address. */
  queued: Map<string, number>;
}

/**
 * A Bee node in memory: the network's chunks, what each batch stamped, and tags that count posts as Bee does. A post
 * whose chunk is still queued from an earlier post under the tag counts as `seen`; `push()` syncs what is queued.
 * `autoPush` pushes every post at once.
 */
export class FakeArchiveNode implements ArchiveNode {
  /** The network: every chunk a reader can fetch. */
  readonly network = new Map<string, Uint8Array>();
  /** What each batch stamped, by address. */
  readonly stamped = new Map<string, Set<string>>();
  readonly tags = new Map<number, FakeTag>();
  readonly posts: Array<{ address: string; batchId: string; tag: number; kind: 'chunk' | 'soc' }> = [];
  readonly reads: string[] = [];
  readonly fileReads: string[] = [];
  /** Chunks the network lost that a file read restores, as Bee does from parity. */
  readonly restorable = new Map<string, Uint8Array>();
  /** Batches that refuse a post, with how. */
  readonly refusing = new Map<string, 'batch_full' | 'batch_unusable'>();
  /** Chunks a post stores under another address. */
  readonly misstored = new Set<string>();
  /** Stamps a batch used before the test, beside what it stamped here. */
  readonly used = new Map<string, number>();
  /** Chunks whose reads the node does not answer, as during an outage. */
  readonly unreachable = new Set<string>();
  /** Chunks the network gives only after this many reads answered not found. */
  readonly missingFor = new Map<string, number>();
  autoPush = true;
  nextTag = 1;
  /** Runs after each post is answered. */
  onPost: (() => void) | null = null;
  /** Holds every post once this many were answered, until `release()`: a copy caught in the middle. */
  holdAfter: number | null = null;
  held = false;
  private releaseHeld: (() => void) | null = null;
  private heldGate: Promise<void> | null = null;

  /** Lets held posts go, and holds no more. */
  release(): void {
    this.holdAfter = null;
    this.held = false;
    this.releaseHeld?.();
    this.releaseHeld = null;
    this.heldGate = null;
  }

  private async gate(): Promise<void> {
    if (this.holdAfter === null || this.posts.length < this.holdAfter) return;
    this.held = true;
    this.heldGate ??= new Promise<void>((resolve) => (this.releaseHeld = resolve));
    await this.heldGate;
  }

  async readChunk(_url: string, address: string): Promise<Uint8Array> {
    this.reads.push(address);
    if (this.unreachable.has(address)) throw new ArchiveNodeError('node', 'The node did not answer.');
    const late = this.missingFor.get(address) ?? 0;
    if (late > 0) {
      this.missingFor.set(address, late - 1);
      throw new ChunkMissingError(address);
    }
    const chunk = this.network.get(address);
    if (!chunk) throw new ChunkMissingError(address);
    return chunk;
  }

  async readFile(_url: string, reference: string): Promise<void> {
    this.fileReads.push(reference);
    for (const [address, chunk] of this.restorable) this.network.set(address, chunk);
  }

  async postChunk(_url: string, batchId: string, tagUid: number, chunk: Uint8Array): Promise<string> {
    await this.gate();
    const real = chunkAddress(chunk);
    return this.store(this.misstored.has(real) ? '0'.repeat(64) : real, batchId, tagUid, chunk, 'chunk');
  }

  async postSoc(_url: string, batchId: string, tagUid: number, soc: SocPost): Promise<string> {
    await this.gate();
    const address = Bytes.keccak256(
      Bytes.concat(Buffer.from(soc.identifier, 'hex'), Buffer.from(soc.owner.replace(/^0x/, ''), 'hex')),
    ).toHex();
    const bytes = new Uint8Array(SOC_HEADER_BYTES + soc.wrapped.length);
    bytes.set(Buffer.from(soc.identifier, 'hex'), 0);
    bytes.set(Buffer.from(soc.signature, 'hex'), 32);
    bytes.set(soc.wrapped, SOC_HEADER_BYTES);
    return this.store(address, batchId, tagUid, bytes, 'soc');
  }

  async createTag(): Promise<number> {
    const uid = this.nextTag++;
    this.tags.set(uid, { split: 0, seen: 0, stored: 0, sent: 0, synced: 0, queued: new Map() });
    return uid;
  }

  async readTag(_url: string, uid: number): Promise<TagReading | null> {
    const tag = this.tags.get(uid);
    if (!tag) return null;
    return { split: tag.split, seen: tag.seen, stored: tag.stored, sent: tag.sent, synced: tag.synced };
  }

  async bucketSum(_url: string, batchId: string): Promise<number> {
    return (this.stamped.get(batchId)?.size ?? 0) + (this.used.get(batchId) ?? 0);
  }

  /** Syncs every post queued under the tag. */
  push(uid: number): void {
    const tag = this.tags.get(uid);
    if (!tag) return;
    for (const count of tag.queued.values()) tag.synced += count;
    tag.sent += tag.queued.size;
    tag.queued.clear();
  }

  private store(address: string, batchId: string, tagUid: number, bytes: Uint8Array, kind: 'chunk' | 'soc'): string {
    const refusal = this.refusing.get(batchId);
    if (refusal) {
      throw new ArchiveNodeError(
        refusal,
        refusal === 'batch_full'
          ? 'The archive stamp is full: batch is overissued.'
          : 'The archive stamp cannot be used yet.',
      );
    }
    const tag = this.tags.get(tagUid);
    if (!tag) throw new ArchiveNodeError('tag_gone', "The node does not know the copy's tag.");
    this.posts.push({ address, batchId, tag: tagUid, kind });
    this.network.set(address, bytes);
    const stamped = this.stamped.get(batchId) ?? new Set();
    stamped.add(address);
    this.stamped.set(batchId, stamped);
    tag.split += 1;
    if (tag.queued.has(address)) tag.seen += 1;
    else tag.queued.set(address, 1);
    if (this.autoPush) this.push(tagUid);
    this.onPost?.();
    return address;
  }
}

/** The SQL of ArchiveRepository, in memory: one job, moves conditional on the state they move from. */
export class InMemoryArchiveStore implements ArchiveStore {
  job: ArchiveJobRow | null = null;
  rows: ArchiveItemRow[] = [];
  readonly segments = new Map<string, ArchiveSegmentDone>();
  readonly archives = new Map<string, StreamArchiveRow>();
  readonly purchases = new Map<string, ArchivePurchaseRow>();
  readonly dismissals = new Set<string>();
  rate: number | null = null;
  readonly archivedOnly = new Map<string, boolean>();
  /** Whether an export holds the place, as stream_exports would say. */
  exportHolds = false;

  constructor(private readonly titles: (streamId: string) => string | null) {}

  async getJob(): Promise<ArchiveJobRow | null> {
    return this.job ? { ...this.job } : null;
  }

  async viewJob(userId: string | null): Promise<ArchiveJobView | null> {
    if (!this.job) return null;
    const title = this.titles(this.job.stream_id);
    if (title === null) return null;
    return {
      ...this.job,
      stream_title: title,
      dismissed: userId !== null && this.dismissals.has(`${this.job.id}:${userId}`),
    };
  }

  async items(jobId: string): Promise<ArchiveItemRow[]> {
    return this.rows
      .filter((item) => item.job_id === jobId)
      .sort((a, b) => a.position - b.position)
      .map((item) => ({ ...item }));
  }

  async createJob(input: NewArchiveJob): Promise<{ row: ArchiveJobRow } | { refused: PlaceRefusal }> {
    if (this.exportHolds) return { refused: 'export' };
    if (this.job && this.job.state !== 'done') return { refused: 'archive' };
    const now = new Date();
    this.rows = [];
    this.segments.clear();
    this.job = {
      id: input.id,
      stream_id: input.streamId,
      batch_id: input.batchId,
      buy_new: input.buyNew,
      purchase_id: null,
      state: 'measuring',
      pause_reason: null,
      pause_message: null,
      paused_at: null,
      chunks_total: null,
      chunks_per_second: null,
      bzz_estimate_low_plur: null,
      bzz_estimate_high_plur: null,
      chequebook_before_plur: null,
      bzz_spent_plur: null,
      started_by_user_id: input.startedByUserId,
      started_by: input.startedBy,
      started_at: now,
      updated_at: now,
      finished_at: null,
    };
    input.items.forEach((item, position) =>
      this.rows.push({
        job_id: input.id,
        rendition: item.rendition,
        position,
        feed_owner: item.feedOwner,
        feed_topic: item.feedTopic,
        manifest_index: item.manifestIndex,
        state: 'waiting',
        result: null,
        segments_total: null,
        segments_done: 0,
        chunks_total: null,
        chunks_copied: 0,
        chunks_rebuilt: 0,
        parity_missing: 0,
        bytes_copied: 0,
        tag_uid: null,
        posts_under_tag: 0,
        chunks_synced: 0,
        chunks_seen: 0,
        bucket_sum_before: null,
      }),
    );
    return { row: { ...this.job } };
  }

  async transition(
    id: string,
    from: readonly ArchiveJobState[],
    change: ArchiveJobChange,
  ): Promise<ArchiveJobRow | null> {
    if (!this.job || this.job.id !== id || !from.includes(this.job.state)) return null;
    const job = { ...this.job };
    job.state = change.state;
    if (change.state === 'paused') {
      job.pause_reason = change.pauseReason ?? 'problem';
      job.pause_message = change.pauseMessage ?? null;
      job.paused_at = new Date();
    } else {
      job.pause_reason = null;
      job.pause_message = null;
      job.paused_at = null;
    }
    if (change.batchId !== undefined) job.batch_id = change.batchId;
    if (change.buyNew !== undefined) job.buy_new = change.buyNew;
    if (change.purchaseId !== undefined) job.purchase_id = change.purchaseId;
    if (change.chunksTotal !== undefined) job.chunks_total = change.chunksTotal;
    if (change.chunksPerSecond !== undefined) job.chunks_per_second = change.chunksPerSecond;
    if (change.bzzEstimateLowPlur !== undefined) job.bzz_estimate_low_plur = change.bzzEstimateLowPlur;
    if (change.bzzEstimateHighPlur !== undefined) job.bzz_estimate_high_plur = change.bzzEstimateHighPlur;
    if (change.chequebookBeforePlur !== undefined) job.chequebook_before_plur = change.chequebookBeforePlur;
    if (change.bzzSpentPlur !== undefined) job.bzz_spent_plur = change.bzzSpentPlur;
    job.finished_at = change.state === 'done' ? (job.finished_at ?? new Date()) : null;
    // The checks of migration 028.
    if (job.batch_id === null && !job.buy_new) throw new Error('archive_jobs_target');
    if (['copying', 'verifying', 'done'].includes(job.state) && job.batch_id === null) {
      throw new Error('archive_jobs_copy_needs_stamp');
    }
    this.job = job;
    return { ...job };
  }

  async transitionTakingPlace(
    id: string,
    from: readonly ArchiveJobState[],
    change: ArchiveJobChange,
  ): Promise<ArchiveJobRow | { refused: PlaceRefusal } | null> {
    if (this.exportHolds) return { refused: 'export' };
    return this.transition(id, from, change);
  }

  async updateItem(jobId: string, rendition: string, change: ArchiveItemChange): Promise<void> {
    const item = this.rows.find((row) => row.job_id === jobId && row.rendition === rendition);
    if (!item) return;
    const columns: Record<keyof ArchiveItemChange, keyof ArchiveItemRow> = {
      state: 'state',
      result: 'result',
      feedTopic: 'feed_topic',
      manifestIndex: 'manifest_index',
      segmentsTotal: 'segments_total',
      segmentsDone: 'segments_done',
      chunksTotal: 'chunks_total',
      chunksCopied: 'chunks_copied',
      chunksRebuilt: 'chunks_rebuilt',
      parityMissing: 'parity_missing',
      bytesCopied: 'bytes_copied',
      tagUid: 'tag_uid',
      postsUnderTag: 'posts_under_tag',
      chunksSynced: 'chunks_synced',
      chunksSeen: 'chunks_seen',
      bucketSumBefore: 'bucket_sum_before',
    };
    for (const key of Object.keys(change) as Array<keyof ArchiveItemChange>) {
      if (change[key] !== undefined) (item as unknown as Record<string, unknown>)[columns[key]] = change[key];
    }
  }

  async recordSegment(
    jobId: string,
    rendition: string,
    segment: ArchiveSegmentDone,
    change: ArchiveItemChange,
  ): Promise<void> {
    this.segments.set(`${jobId}:${rendition}:${segment.reference}`, segment);
    await this.updateItem(jobId, rendition, change);
  }

  async segmentsDone(jobId: string, rendition: string): Promise<Set<string>> {
    const prefix = `${jobId}:${rendition}:`;
    return new Set(
      [...this.segments.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
    );
  }

  async clearSegments(jobId: string, rendition: string): Promise<void> {
    const prefix = `${jobId}:${rendition}:`;
    for (const key of [...this.segments.keys()]) if (key.startsWith(prefix)) this.segments.delete(key);
  }

  async removeJob(id: string): Promise<boolean> {
    if (!this.job || this.job.id !== id) return false;
    this.job = null;
    this.rows = [];
    this.segments.clear();
    return true;
  }

  async dismiss(id: string, userId: string): Promise<boolean> {
    if (!this.job || this.job.id !== id || this.job.state !== 'done') return false;
    this.dismissals.add(`${id}:${userId}`);
    return true;
  }

  async lastRate(): Promise<number | null> {
    return this.rate;
  }

  async saveRate(chunksPerSecond: number): Promise<void> {
    this.rate = chunksPerSecond;
  }

  async archivesOf(streamIds: readonly string[] | null): Promise<StreamArchiveRow[]> {
    return [...this.archives.values()]
      .filter((row) => streamIds === null || streamIds.includes(row.stream_id))
      .map((row) => ({ ...row }));
  }

  async startArchive(row: NewStreamArchive): Promise<void> {
    const key = `${row.stream_id}:${row.rendition}`;
    const before = this.archives.get(key);
    this.archives.set(key, {
      ...row,
      state: 'partial',
      completed_at: null,
      completed_by_user_id: null,
      completed_by: null,
      stamp_expires_at: before?.batch_id === row.batch_id ? before.stamp_expires_at : null,
    });
  }

  async saveArchive(streamId: string, rendition: string, change: StreamArchiveChange): Promise<void> {
    const row = this.archives.get(`${streamId}:${rendition}`);
    if (!row) return;
    for (const [key, value] of Object.entries(change)) {
      if (value !== undefined) (row as unknown as Record<string, unknown>)[key] = value;
    }
  }

  async completeArchive(streamId: string, rendition: string, byUserId: string | null, by: string): Promise<void> {
    const row = this.archives.get(`${streamId}:${rendition}`);
    if (!row) return;
    row.state = 'complete';
    row.completed_at = new Date();
    row.completed_by_user_id = byUserId;
    row.completed_by = by;
  }

  async setArchivedOnly(streamId: string, archivedOnly: boolean): Promise<boolean> {
    this.archivedOnly.set(streamId, archivedOnly);
    return true;
  }

  async createPurchase(input: NewPurchase): Promise<ArchivePurchaseRow | null> {
    if ([...this.purchases.values()].some((row) => row.state === 'buying' || row.state === 'waiting_usable')) {
      return null;
    }
    const now = new Date();
    const row: ArchivePurchaseRow = {
      id: input.id,
      depth: input.depth,
      days: input.days,
      amount_per_chunk_plur: input.amountPerChunkPlur,
      cost_plur: input.costPlur,
      label: input.label,
      state: 'buying',
      batch_id: null,
      tx_hash: null,
      error: null,
      relayed_at: null,
      started_by_user_id: input.startedByUserId,
      started_by: input.startedBy,
      started_at: now,
      updated_at: now,
    };
    this.purchases.set(row.id, row);
    return { ...row };
  }

  async getPurchase(id: string): Promise<ArchivePurchaseRow | null> {
    const row = this.purchases.get(id);
    return row ? { ...row } : null;
  }

  async updatePurchase(id: string, change: PurchaseChange): Promise<ArchivePurchaseRow | null> {
    const row = this.purchases.get(id);
    if (!row) return null;
    if (change.state !== undefined) row.state = change.state;
    if (change.batchId !== undefined) row.batch_id = change.batchId;
    if (change.txHash !== undefined) row.tx_hash = change.txHash;
    if (change.error !== undefined) row.error = change.error;
    if (change.relayed === true) row.relayed_at ??= new Date();
    if (change.relayed === false) row.relayed_at = null;
    return { ...row };
  }

  async listPurchases(limit: number): Promise<ArchivePurchaseRow[]> {
    return [...this.purchases.values()].slice(0, limit).map((row) => ({ ...row }));
  }
}

/** One archive batch as the manager pushes it. */
export function archiveBatch(batchId: string, over: Partial<CatalogueArchiveBatch> = {}): CatalogueArchiveBatch {
  return {
    batchId,
    label: 'archive one',
    immutable: true,
    depth: 20,
    state: 'active',
    ttlSeconds: 90 * 86_400,
    fillRatio: 0,
    writable: true,
    designatedAt: '2026-11-13T10:00:00.000Z',
    ...over,
  };
}

/** The catalogue stamp row the archive reads: the catalogue node and its archive batches. */
export class FakeCatalogue {
  batches: CatalogueArchiveBatch[] = [];
  /** Whether the record carries `archiveBatches`, as a manager older than the field's does not. */
  listsArchiveBatches = true;
  beeApiUrl = 'http://catalogue-node.test:1633';
  designated = true;
  observedAt = new Date().toISOString();

  async get(): Promise<CatalogueStampRow | null> {
    if (!this.designated) return null;
    const record = {
      schemaVersion: 1,
      managerId: '00000000-0000-4000-8000-0000000000aa',
      nodeName: 'catalogue-node',
      beeApiUrl: this.beeApiUrl,
      batchId: 'c'.repeat(64),
      immutable: true,
      depth: 20,
      state: 'active',
      ttlSeconds: 90 * 86_400,
      fillRatio: 0,
      designatedAt: '2026-11-13T10:00:00.000Z',
      observedAt: this.observedAt,
      ...(this.listsArchiveBatches ? { archiveBatches: this.batches } : {}),
    } as unknown as CatalogueStampRecord;
    return {
      manager_id: '00000000-0000-4000-8000-0000000000aa',
      batch_id: 'c'.repeat(64),
      record,
      observed_at: new Date(this.observedAt),
      received_at: new Date(this.observedAt),
      cleared_observed_at: null,
      cleared_at: null,
      active_batch_id: 'c'.repeat(64),
      active_record: record,
    } as unknown as CatalogueStampRow;
  }
}
