import { randomUUID } from 'node:crypto';

import {
  archiveBatchCostPlur,
  archiveChunksWithMargin,
  archiveEffectiveChunks,
  smallestArchiveDepthFor,
  type CatalogueArchiveBatch,
  type FundingInventory,
} from '@streaming-monorepo/contracts';
import {
  ARCHIVE_BUY_MIN_DAYS,
  ARCHIVE_PURCHASES_NOT_OFFERED,
  archiveBuyAmountPerChunkPlur,
  archiveBuyProblem,
  archiveHoldsPlace,
  archiveStampFits,
  archiveWalletShortfallPlur,
  holdsFinishedRecording,
  isArchived,
  type ArchiveAction,
  type ArchiveActionRequest,
  type ArchiveBuyChoice,
  type ArchiveBuyTerms,
  type ArchivedStream,
  type ArchiveJobItem,
  type ArchiveJobState,
  type ArchiveJobSummary,
  type ArchiveOptionsResponse,
  type ArchivePauseReason,
  type ArchivePurchaseProposal,
  type ArchiveQuality,
  type ArchiveRefusal,
  type ArchiveStamp,
  type ArchiveStampPurchase,
  type ArchiveStampsResponse,
  type ArchiveStartRequest,
  type ArchiveStreamsResponse,
  type StreamArchiveSummary,
} from '@streaming-monorepo/web2-admin-common';

import { isDesignated, type CatalogueStampRow, type StreamRenditionRow, type StreamRow } from '../../types/index.js';
import type { ArchiveSettings } from '../../utils/archiveSettings.js';
import { getErrorMessage } from '../../utils/errorUtils.js';
import { describeActor, type Actor, type OperatorActor } from '../actor.js';
import { recordAudit, type AuditAction, type AuditLog } from '../AuditLog.js';
import { withoutCatalogueNode } from '../catalogueNodeText.js';
import { ArchiveNotFoundError, ArchiveRefusedError, StreamNotFoundError } from '../errors/index.js';
import { broadcastDay } from '../export/names.js';
import { parseRecordingPlaylist, PlaylistFormatError } from '../export/playlist.js';
import { ManagerFundingError, type ManagerFundingClient } from '../funding/ManagerFundingClient.js';
import { Logger } from '../Logger.js';

import { ArchiveNodeError, ChunkMissingError, type ArchiveNode, type TagReading } from './ArchiveNode.js';
import type {
  ArchiveItemChange,
  ArchiveItemRow,
  ArchiveJobChange,
  ArchiveJobRow,
  ArchiveJobView,
  ArchivePurchaseRow,
  ArchiveStore,
  StreamArchiveRow,
} from './ArchiveRepository.js';
import {
  archivedRenditions,
  bzzEstimate,
  currentIndexes,
  qualityState,
  SOURCE_RENDITION,
  stampProblem,
  streamArchiveSummary,
  toArchiveStamp,
  type ArchiveStampsHeld,
} from './archiveStates.js';
import { treeChunks } from './chunkTree.js';
import {
  emptyCounters,
  pool,
  sleep,
  SlotMissingError,
  UnreadableChunkError,
  type ChunkCopier,
  type CopyContext,
  type CopyCounters,
} from './ChunkCopier.js';

const logger = Logger.getInstance();

const SYSTEM_ARCHIVE: Actor = { kind: 'system', reason: 'archive' };

/**
 * Archiving a recording: the chosen qualities of a finished recording copied, chunk by chunk, onto an archive stamp
 * on the catalogue node, one job at a time for the whole admin, sharing its place with the export.
 * `docs/architecture/web2-admin.md`, "Archiving a recording", is the design, and `archive.ts` of the admin's common
 * types the shapes.
 *
 * The job measures every chosen quality's segments, waits for a user to confirm a stamp to buy if one was asked for,
 * copies each quality under a Bee tag of its own, then waits until Bee reports every post synced. It never fails:
 * anything that stops it pauses it with a reason, and a user decides. Progress is saved per segment, so a restart, a
 * pause or a stream that recorded again loses at most the segment in flight, which is copied whole again at no room.
 *
 * State moves are conditional on the state they move from, so a user's action and the job's own move never both
 * apply: whichever lands first wins, and the other finds the job moved on.
 */

export interface ArchiveStreams {
  findById(id: string): Promise<StreamRow | null>;
}

export interface ArchiveRenditions {
  listByStream(streamId: string): Promise<StreamRenditionRow[]>;
}

/** The catalogue stamp row, whose record names the catalogue node and carries the archive stamps. */
export interface ArchiveCatalogue {
  get(): Promise<CatalogueStampRow | null>;
}

/** The slice of the manager's funding API the archive uses: the inventory, and the purchases. */
export type ArchiveManager = Pick<ManagerFundingClient, 'inventory' | 'stampPurchase' | 'stampPurchaseStatus'>;

/** Rewrites a stream's catalogue entry, for the "List only archived qualities" switch. */
export interface ArchivePublisher {
  republishWithState(actor: Actor, stream: StreamRow): Promise<unknown>;
}

/** Whether an export holds the job's place, in the sentence that says which; null when none does. */
export interface ArchiveExports {
  exportHoldingPlace(): Promise<string | null>;
}

export interface ArchiveServiceOptions {
  settings: ArchiveSettings;
  /** How often the watch looks at a waiting job and the purchases under way. */
  watchIntervalMs?: number;
  /** How often the stream and the node are looked at during a copy. */
  statusCheckMs?: number;
  /** How often the chequebook is read during a copy. */
  fundsCheckMs?: number;
  /** How often a tag or a purchase is read while the job waits on it. */
  pollMs?: number;
  /** How long Bee may push nothing of a quality before the job pauses. */
  tagStallMs?: number;
  /** How long a purchase may take to become usable before the job pauses. */
  purchaseTimeoutMs?: number;
  /**
   * How long a purchase's start waits for the manager's first answer, so a refusal is answered to the user who asked.
   * A purchase the manager takes is answered once mined, which takes longer, and is followed in the background.
   */
  purchaseAnswerWaitMs?: number;
  now?: () => number;
}

interface RunningJob {
  id: string;
  controller: AbortController;
  promise: Promise<void>;
}

/** A pause the job decided on, with its reason and sentence. */
class ArchivePause extends Error {
  constructor(
    readonly reason: Exclude<ArchivePauseReason, 'user'>,
    message: string,
  ) {
    super(message);
    this.name = 'ArchivePause';
  }
}

/** The job moved on under the pass, by a user or by another pass: nothing to do but look again. */
class MovedOn extends Error {}

const ACTIVE: readonly ArchiveJobState[] = ['measuring', 'buying', 'waiting_usable', 'copying', 'verifying'];

const DEFAULT_WATCH_INTERVAL_MS = 10_000;
const DEFAULT_STATUS_CHECK_MS = 5_000;
const DEFAULT_FUNDS_CHECK_MS = 60_000;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_TAG_STALL_MS = 10 * 60_000;
const DEFAULT_PURCHASE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_PURCHASE_ANSWER_WAIT_MS = 5_000;
/** How long the manager's inventory is reused for what the widget and the Stamps tab read every few seconds. */
const INVENTORY_REUSE_MS = 15_000;
/** Why the manager refused a purchase because another operation was under way on the catalogue node. */
const NODE_BUSY =
  'Another operation is under way on the catalogue node, so nothing was bought. Try again once it is done.';
/** The purchases the Stamps tab lists. */
const PURCHASES_LISTED = 10;
/** Parity a segment of erasure level 1 adds, which step 0 measured at 9 to 12.1%: for the estimate before measuring. */
const PARITY_ESTIMATE = 1.125;

/** `ab12cd34…`: enough of a batch id to recognise it in a sentence or a log. */
function shortBatch(batchId: string): string {
  return `${batchId.slice(0, 8)}…`;
}

function labelOf(rendition: string): string {
  return rendition === SOURCE_RENDITION ? 'Source' : rendition;
}

/**
 * The feed topic of the first quality a master playlist lists, as the viewer reads it for a stream card's frame: the
 * URI after the first `#EXT-X-STREAM-INF` that names an owner and a topic, `swarm://<owner>/<topic>` or the bare
 * `<owner>/<topic>`. Null when it lists none.
 */
function firstVariantTopic(master: string): string | null {
  const lines = master.split(/\r?\n/).map((line) => line.trim());
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith('#EXT-X-STREAM-INF')) continue;
    const uri = lines[i + 1];
    if (!uri || uri.startsWith('#')) continue;
    const [owner, topic] = (uri.startsWith('swarm://') ? uri.slice('swarm://'.length) : uri).split('/');
    if (owner && topic) return topic;
    i++;
  }
  return null;
}

function statusWords(status: StreamRow['status']): string {
  switch (status) {
    case 'draft':
      return 'a draft with no recording';
    case 'publishing':
      return 'being published';
    case 'published':
      return 'scheduled and has not started';
    case 'live':
      return 'live now';
    case 'vod':
      return 'recorded';
  }
}

function stateWords(state: ArchiveJobState): string {
  switch (state) {
    case 'measuring':
      return 'is measuring the recording';
    case 'awaiting_purchase':
      return 'waits for a stamp to be bought';
    case 'buying':
      return 'is buying its stamp';
    case 'waiting_usable':
      return 'waits for its new stamp to become usable';
    case 'copying':
      return 'is copying';
    case 'verifying':
      return 'waits for Swarm to confirm the copy';
    case 'paused':
      return 'is paused';
    case 'waiting':
      return 'waits for its stream to finish';
    case 'done':
      return 'is done';
  }
}

function busyMessage(view: Pick<ArchiveJobView, 'stream_title' | 'state' | 'started_by'>): string {
  return `The archive of "${view.stream_title}" ${stateWords(view.state)}, started by ${view.started_by}. One archive or export runs at a time.`;
}

function liveMessage(): string {
  return 'The stream went live again, so its recording is changing. Wait until it finishes, or cancel.';
}

function stalledMessage(stallMs: number): string {
  return `The catalogue node has pushed none of the copy's chunks for ${Math.round(stallMs / 60_000)} minutes. Try again, or cancel.`;
}

/** What a user can do to the job in the state it is in. The console shows these, and `act` refuses anything else. */
export function archiveActionsFor(
  row: Pick<ArchiveJobRow, 'state' | 'pause_reason'>,
  dismissed: boolean,
): ArchiveAction[] {
  switch (row.state) {
    case 'measuring':
    case 'buying':
    case 'waiting_usable':
    case 'copying':
    case 'verifying':
      return ['pause', 'cancel'];
    case 'awaiting_purchase':
      // The purchase is confirmed on its own route, with the choice: archiveConfirmPurchasePath(id).
      return ['use_stamp', 'cancel'];
    case 'waiting':
      return ['cancel'];
    case 'paused':
      if (row.pause_reason === 'live') return ['wait', 'cancel'];
      if (row.pause_reason === 'batch') return ['resume', 'use_stamp', 'buy_new', 'cancel'];
      return ['resume', 'cancel'];
    case 'done':
      return dismissed ? [] : ['dismiss'];
  }
}

function actionWords(action: ArchiveAction): string {
  switch (action) {
    case 'pause':
      return 'be paused';
    case 'resume':
      return 'be resumed';
    case 'wait':
      return 'wait for the stream';
    case 'use_stamp':
      return 'change its stamp';
    case 'buy_new':
      return 'buy a new stamp';
    case 'cancel':
      return 'be cancelled';
    case 'dismiss':
      return 'be closed';
  }
}

/** Whether Bee reports every post under the tag pushed: `split` is the posts made, and `synced` plus `seen` is `split`. */
export function tagComplete(tag: TagReading, posts: number): boolean {
  return tag.split === posts && tag.synced + tag.seen === tag.split;
}

function toPurchase(row: ArchivePurchaseRow): ArchiveStampPurchase {
  return {
    id: row.id,
    depth: row.depth,
    days: row.days,
    amountPerChunkPlur: row.amount_per_chunk_plur,
    costPlur: row.cost_plur,
    label: row.label,
    state: row.state,
    batchId: row.batch_id,
    error: row.error,
    startedBy: row.started_by,
    startedAt: row.started_at.toISOString(),
  };
}

/**
 * The archive stamps the catalogue stamp row holds, or null when the admin was not told: before any record arrived,
 * or from a record without the field, which a manager older than it sends.
 */
function heldStamps(row: CatalogueStampRow | null): ArchiveStampsHeld | null {
  if (!row?.record?.archiveBatches) return null;
  return { batches: row.record.archiveBatches, observedAt: row.record.observedAt };
}

/** The catalogue node's Bee API address, or the sentence that says why there is none. */
function nodeOf(row: CatalogueStampRow | null): { url: string; name: string } | { problem: string } {
  if (!isDesignated(row)) {
    return {
      problem: 'There is no catalogue node to copy through: the manager has not designated a catalogue batch yet.',
    };
  }
  return { url: row.record.beeApiUrl, name: row.record.nodeName };
}

function plurMinus(before: string | null, after: string | null): string | null {
  if (before === null || after === null) return null;
  const spent = BigInt(before) - BigInt(after);
  return spent > 0n ? spent.toString() : '0';
}

function normalBatch(batchId: string): string {
  return batchId.replace(/^0x/i, '').toLowerCase();
}

export class ArchiveService {
  private job: RunningJob | null = null;
  private watcher: NodeJS.Timeout | null = null;
  private stopping = false;
  private ticking: Promise<void> | null = null;
  private readonly advancing = new Map<string, Promise<void>>();
  /** What the chequebook could pay as last read, for the widget, which reads the job every few seconds. */
  private lastChequebook: string | null = null;
  /** The purchases the manager refused while another operation was under way on the node, until they are answered. */
  private readonly nodeBusy = new Set<string>();
  /** Why the last funds check was skipped, or null, so a skip is logged once until its reason changes. */
  private fundsSkipped: string | null = null;
  private readonly watchIntervalMs: number;
  private readonly statusCheckMs: number;
  private readonly fundsCheckMs: number;
  private readonly pollMs: number;
  private readonly tagStallMs: number;
  private readonly purchaseTimeoutMs: number;
  private readonly purchaseAnswerWaitMs: number;
  private inventoryRead: { at: number; inventory: FundingInventory } | null = null;
  private readonly now: () => number;

  constructor(
    private readonly store: ArchiveStore,
    private readonly streams: ArchiveStreams,
    private readonly renditions: ArchiveRenditions,
    private readonly catalogue: ArchiveCatalogue,
    private readonly node: ArchiveNode,
    private readonly copier: ChunkCopier,
    private readonly manager: ArchiveManager | null,
    private readonly publisher: ArchivePublisher,
    private readonly exports: ArchiveExports,
    private readonly audit: AuditLog,
    private readonly options: ArchiveServiceOptions,
  ) {
    this.watchIntervalMs = options.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
    this.statusCheckMs = options.statusCheckMs ?? DEFAULT_STATUS_CHECK_MS;
    this.fundsCheckMs = options.fundsCheckMs ?? DEFAULT_FUNDS_CHECK_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.tagStallMs = options.tagStallMs ?? DEFAULT_TAG_STALL_MS;
    this.purchaseTimeoutMs = options.purchaseTimeoutMs ?? DEFAULT_PURCHASE_TIMEOUT_MS;
    this.purchaseAnswerWaitMs = options.purchaseAnswerWaitMs ?? DEFAULT_PURCHASE_ANSWER_WAIT_MS;
    this.now = options.now ?? Date.now;
  }

  private get settings(): ArchiveSettings {
    return this.options.settings;
  }

  // --- reads -------------------------------------------------------------------

  /** The archive on the server, as the user asking sees it, or null when there is none. */
  async current(userId: string | null): Promise<ArchiveJobSummary | null> {
    const view = await this.store.viewJob(userId);
    return view ? this.summaryOf(view, userId) : null;
  }

  /** For the export: whether an archive holds the place, in the sentence that says which. */
  async archiveHoldingPlace(): Promise<string | null> {
    const view = await this.store.viewJob(null);
    if (!view || !archiveHoldsPlace(view.state, view.pause_reason)) return null;
    return busyMessage(view);
  }

  /** Each stream's archive for the stream list, by id; a stream with nothing copied is left out. */
  async summaries(streams: readonly StreamRow[]): Promise<Map<string, StreamArchiveSummary>> {
    const summaries = new Map<string, StreamArchiveSummary>();
    if (streams.length === 0) return summaries;
    const copies = await this.store.archivesOf(streams.map((stream) => stream.id));
    if (copies.length === 0) return summaries;
    const held = heldStamps(await this.catalogue.get());
    const now = this.now();
    for (const stream of streams) {
      const own = copies.filter((copy) => copy.stream_id === stream.id);
      if (own.length === 0) continue;
      const indexes = currentIndexes(stream, await this.renditions.listByStream(stream.id));
      const summary = streamArchiveSummary(stream, own, indexes, held, now);
      if (summary) summaries.set(stream.id, summary);
    }
    return summaries;
  }

  /**
   * The qualities of a stream that play from an archive stamp now, for its catalogue entry while its "List only
   * archived qualities" switch is on; null while it is off, and while none plays from one, so the entry lists every
   * rung as with the switch off and never none.
   */
  async listedRenditions(stream: StreamRow): Promise<Set<string> | null> {
    if (!stream.archived_only) return null;
    const [copies, rungs, catalogueRow] = await Promise.all([
      this.store.archivesOf([stream.id]),
      this.renditions.listByStream(stream.id),
      this.catalogue.get(),
    ]);
    const archived = archivedRenditions(copies, currentIndexes(stream, rungs), heldStamps(catalogueRow), this.now());
    return archived.size > 0 ? archived : null;
  }

  /** What the panel and the stream's archive card offer for one stream. */
  async optionsFor(streamId: string, userId: string | null): Promise<ArchiveOptionsResponse> {
    const stream = await this.streams.findById(streamId);
    if (!stream) throw new StreamNotFoundError(streamId);
    const [rungs, copies, catalogueRow, view] = await Promise.all([
      this.renditions.listByStream(streamId),
      this.store.archivesOf([streamId]),
      this.catalogue.get(),
      this.store.viewJob(userId),
    ]);
    const now = this.now();
    const held = heldStamps(catalogueRow);
    const qualities = this.qualitiesOf(stream, rungs, copies, held, now, await this.store.lastRate());
    // One reading of the listed stamps answers both lists: where a new copy can go, and what holds a copy already.
    const read = held ? await this.stampsOf(catalogueRow, held, copies) : [];
    const stamps = held
      ? read.filter(
          (stamp) =>
            stampProblem(
              held.batches.find((batch) => batch.batchId === stamp.batchId),
              held.observedAt,
              now,
            ) === null,
        )
      : [];
    const copiedOnto = new Set(copies.map((copy) => copy.batch_id));
    const summary = streamArchiveSummary(stream, copies, currentIndexes(stream, rungs), held, now) ?? {
      state: 'none' as const,
      archived: [],
      archivedOnly: stream.archived_only,
    };
    return {
      streamId: stream.id,
      title: stream.title,
      date: broadcastDay(stream),
      qualities,
      stamps,
      holdingStamps: read.filter((stamp) => copiedOnto.has(stamp.batchId)),
      buy: (await this.buyTerms()).terms,
      // The reading the job's funds check makes, read now: null without funding or when the manager cannot be read.
      chequebookAvailablePlur: await this.readChequebook().catch(() => null),
      summary,
      canListArchivedOnly: rungs.length > 0 && summary.archived.length > 0,
      archivedOnlyHint: null,
      refusal: await this.refusalFor(stream, qualities, catalogueRow, view),
      current: view ? await this.summaryOf(view, userId) : null,
    };
  }

  /** The archive stamps with their room, the purchases under way, and what buying one needs. */
  async stamps(): Promise<ArchiveStampsResponse> {
    const catalogueRow = await this.catalogue.get();
    const held = heldStamps(catalogueRow);
    const [stamps, purchases, buy] = await Promise.all([
      held ? this.stampsOf(catalogueRow, held, await this.store.archivesOf(null)) : Promise.resolve([]),
      this.store.listPurchases(PURCHASES_LISTED),
      this.buyTerms(),
    ]);
    return {
      nodeName: isDesignated(catalogueRow) ? catalogueRow.record.nodeName : null,
      stamps,
      purchases: purchases.map(toPurchase),
      buy: buy.terms,
      buyUnavailable: buy.problem,
      ttlWarningDays: this.settings.ttlWarningDays,
    };
  }

  async purchase(id: string): Promise<ArchiveStampPurchase> {
    const row = await this.store.getPurchase(id);
    if (!row) throw new ArchiveNotFoundError(id);
    return toPurchase(row);
  }

  /** The streams that have an archive, newest copy first, for the Archive page. */
  async archivedStreams(): Promise<ArchiveStreamsResponse> {
    const copies = await this.store.archivesOf(null);
    const held = heldStamps(await this.catalogue.get());
    const now = this.now();
    const byStream = new Map<string, StreamArchiveRow[]>();
    for (const copy of copies) byStream.set(copy.stream_id, [...(byStream.get(copy.stream_id) ?? []), copy]);
    const streams: ArchivedStream[] = [];
    for (const [streamId, own] of byStream) {
      const stream = await this.streams.findById(streamId);
      if (!stream) continue;
      const indexes = currentIndexes(stream, await this.renditions.listByStream(streamId));
      const summary = streamArchiveSummary(stream, own, indexes, held, now);
      if (!summary) continue;
      const qualities = own.map((copy) => {
        const batch = held?.batches.find((candidate) => candidate.batchId === copy.batch_id);
        const stamp =
          batch && held ? toArchiveStamp(batch, held.observedAt, null, 0, this.settings.ttlWarningDays, now) : null;
        return {
          rendition: copy.rendition,
          label: labelOf(copy.rendition),
          state: qualityState(copy, indexes.get(copy.rendition) ?? null, held, now),
          batchId: copy.batch_id,
          batchLabel: batch?.label ?? null,
          bytes: copy.bytes,
          parityMissing: copy.parity_missing,
          batchTtlSeconds: stamp?.ttlSeconds ?? null,
        };
      });
      const newest = own
        .filter((copy) => copy.completed_at !== null)
        .sort((a, b) => b.completed_at!.getTime() - a.completed_at!.getTime())[0];
      streams.push({
        streamId,
        title: stream.title,
        date: broadcastDay(stream),
        summary,
        qualities,
        bytes: qualities
          .filter((quality) => isArchived(quality.state))
          .reduce((sum, quality) => sum + quality.bytes, 0),
        archivedAt: newest?.completed_at?.toISOString() ?? null,
        archivedBy: newest?.completed_by ?? null,
      });
    }
    streams.sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));
    return { streams };
  }

  // --- what a user does ----------------------------------------------------------

  /**
   * Starts archiving the chosen qualities of a stream's recording onto an archive stamp, or onto one to be bought once
   * measured. Refused, with the sentence the console shows, while an export or another archive holds the place, for a
   * stream with no finished recording, with no catalogue node, for a stamp that cannot be written, or for a quality
   * that is archived at its recording already or has not finished.
   */
  async start(actor: OperatorActor, streamId: string, request: ArchiveStartRequest): Promise<ArchiveJobSummary> {
    const stream = await this.streams.findById(streamId);
    if (!stream) throw new StreamNotFoundError(streamId);
    const [rungs, copies, catalogueRow, view] = await Promise.all([
      this.renditions.listByStream(streamId),
      this.store.archivesOf([streamId]),
      this.catalogue.get(),
      this.store.viewJob(actor.userId),
    ]);
    const now = this.now();
    const held = heldStamps(catalogueRow);
    const qualities = this.qualitiesOf(stream, rungs, copies, held, now, await this.store.lastRate());
    const refusal = await this.refusalFor(stream, qualities, catalogueRow, view);
    if (refusal) throw new ArchiveRefusedError(refusal.problem, refusal.message);

    const chosen = [...new Set(request.renditions)];
    if (chosen.length === 0) throw new ArchiveRefusedError('nothing_to_archive', 'Choose at least one quality.');
    const items: Array<{ rendition: string; feedOwner: string; feedTopic: string; manifestIndex: number }> = [];
    for (const rendition of chosen) {
      const quality = qualities.find((candidate) => candidate.rendition === rendition);
      if (!quality) {
        const names = qualities.map((candidate) => candidate.label).join(', ');
        throw new ArchiveRefusedError('nothing_to_archive', `This recording has no ${rendition}; it has ${names}.`);
      }
      if (quality.unavailable) {
        throw new ArchiveRefusedError('nothing_to_archive', `${quality.label}: ${quality.unavailable}`);
      }
      const feed = this.feedOf(stream, rungs, rendition)!;
      items.push({ rendition, feedOwner: feed.owner, feedTopic: feed.topic, manifestIndex: feed.index });
    }

    let batchId: string | null = null;
    if ('batchId' in request.target) {
      batchId = normalBatch(request.target.batchId);
      const batch = held?.batches.find((candidate) => candidate.batchId === batchId);
      const problem = held ? stampProblem(batch, held.observedAt, now) : 'The manager has pushed no archive stamps.';
      if (problem) throw new ArchiveRefusedError(batch ? 'stamp_unusable' : 'no_stamp', problem);
    } else {
      const buy = await this.buyTerms();
      if (!buy.terms) throw new ArchiveRefusedError('purchase_refused', buy.problem ?? 'No stamp can be bought now.');
    }

    const created = await this.store.createJob({
      id: randomUUID(),
      streamId: stream.id,
      batchId,
      buyNew: batchId === null,
      startedByUserId: actor.userId,
      startedBy: describeActor(actor),
      items,
    });
    if ('refused' in created) {
      const message =
        created.refused === 'export'
          ? ((await this.exports.exportHoldingPlace()) ??
            'An export started first. One archive or export runs at a time.')
          : ((await this.archiveHoldingPlace()) ??
            'Another archive started first. One archive or export runs at a time.');
      throw new ArchiveRefusedError('busy', message);
    }
    logger.info(
      `[Archive] ${describeActor(actor)} started archiving "${stream.title}" (${chosen.map(labelOf).join(', ')}) onto ${
        batchId ? `stamp ${shortBatch(batchId)}` : 'a new stamp'
      }`,
    );
    await recordAudit(this.audit, {
      actor,
      action: 'archive.start',
      streamId: stream.id,
      topic: stream.topic,
      details: { archiveId: created.row.id, renditions: chosen, batchId, buyNew: batchId === null },
    });
    this.launch(created.row.id);
    return (await this.current(actor.userId))!;
  }

  /** Pause, resume, wait, confirm a purchase, change the stamp, cancel, or close the widget. */
  async act(actor: OperatorActor, jobId: string, request: ArchiveActionRequest): Promise<ArchiveJobSummary | null> {
    const view = await this.store.viewJob(actor.userId);
    if (!view || view.id !== jobId) throw new ArchiveNotFoundError(jobId);
    const { action } = request;
    const notNow = () =>
      new ArchiveRefusedError(
        'not_now',
        `The archive ${stateWords(view.state)}, so it cannot ${actionWords(action)} now.`,
      );
    if (!archiveActionsFor(view, view.dismissed).includes(action)) throw notNow();
    const audit = (auditAction: AuditAction, details: Record<string, unknown> = {}) =>
      recordAudit(this.audit, {
        actor,
        action: auditAction,
        streamId: view.stream_id,
        details: { archiveId: jobId, ...details },
      });
    const who = describeActor(actor);

    switch (request.action) {
      case 'pause': {
        const paused = await this.store.transition(jobId, ACTIVE, {
          state: 'paused',
          pauseReason: 'user',
          pauseMessage: `Paused by ${who}.`,
        });
        if (!paused) throw notNow();
        await this.stopJob(jobId);
        logger.info(`[Archive] ${who} paused the archive of "${view.stream_title}"`);
        await audit('archive.pause', { from: view.state });
        break;
      }
      case 'resume': {
        const next = await this.resumeState(view, await this.store.items(jobId));
        const change: ArchiveJobChange = { state: next };
        const resumed =
          view.pause_reason === 'user' && archiveHoldsPlace(next, null)
            ? await this.store.transitionTakingPlace(jobId, ['paused'], change)
            : await this.store.transition(jobId, ['paused'], change);
        if (resumed && 'refused' in resumed) {
          throw new ArchiveRefusedError(
            'busy',
            (await this.exports.exportHoldingPlace()) ??
              'An export holds the place. The archive can resume once it is done.',
          );
        }
        if (!resumed) throw notNow();
        logger.info(`[Archive] ${who} resumed the archive of "${view.stream_title}"`);
        await audit('archive.resume', { after: view.pause_reason, state: next });
        this.launch(jobId);
        break;
      }
      case 'wait': {
        if (!(await this.store.transition(jobId, ['paused'], { state: 'waiting' }))) throw notNow();
        logger.info(`[Archive] ${who} set the archive of "${view.stream_title}" to wait until the stream finishes`);
        await audit('archive.wait');
        await this.tick();
        break;
      }
      case 'use_stamp':
        await this.useStamp(actor, view, request.batchId, notNow);
        break;
      case 'buy_new': {
        const moved = await this.store.transition(jobId, ['paused'], {
          state: 'awaiting_purchase',
          batchId: null,
          buyNew: true,
          purchaseId: null,
        });
        if (!moved) throw notNow();
        logger.info(`[Archive] ${who} chose to buy a new stamp for the archive of "${view.stream_title}"`);
        await audit('archive.buy_new', { previousBatchId: view.batch_id });
        break;
      }
      case 'cancel': {
        if (!(await this.store.removeJob(jobId))) throw new ArchiveNotFoundError(jobId);
        await this.stopJob(jobId);
        logger.info(`[Archive] ${who} cancelled the archive of "${view.stream_title}"`);
        await audit('archive.cancel', { state: view.state });
        return null;
      }
      case 'dismiss': {
        if (!(await this.store.dismiss(jobId, actor.userId))) throw notNow();
        break;
      }
    }
    return this.current(actor.userId);
  }

  /** Starts a purchase from the Stamps tab. Answers it as it starts; the manager is asked in the background. */
  async buy(actor: OperatorActor, choice: ArchiveBuyChoice): Promise<ArchiveStampPurchase> {
    const row = await this.newPurchase(actor, choice, null);
    return toPurchase(await this.relayAnswered(row.id));
  }

  /**
   * Confirms the stamp the archive `jobId`, waiting in `awaiting_purchase`, is to buy: the choice is priced again, the
   * purchase recorded, the place taken and the manager asked. A `jobId` that is not the current archive's is refused
   * before anything is recorded: the archive the buy dialog was opened for is gone. A refusal the manager answers at
   * once puts the archive back to waiting for a confirm, and is answered here. Otherwise the job follows the purchase
   * through `buying` and `waiting_usable` to `copying`.
   */
  async confirmPurchase(
    actor: OperatorActor,
    jobId: string,
    choice: ArchiveBuyChoice,
  ): Promise<ArchiveJobSummary | null> {
    const view = await this.store.viewJob(actor.userId);
    if (view && view.id !== jobId) {
      throw new ArchiveRefusedError('not_now', 'The archive moved on, so it cannot buy a stamp now.');
    }
    if (!view || view.state !== 'awaiting_purchase' || view.chunks_total === null) {
      throw new ArchiveRefusedError(
        'not_now',
        view
          ? `The archive ${stateWords(view.state)}, so it cannot buy a stamp now.`
          : 'There is no archive waiting for a stamp to be bought.',
      );
    }
    const row = await this.newPurchase(actor, choice, archiveChunksWithMargin(view.chunks_total));
    const moved = await this.store.transitionTakingPlace(view.id, ['awaiting_purchase'], {
      state: 'buying',
      purchaseId: row.id,
      buyNew: true,
      batchId: null,
    });
    if (!moved || 'refused' in moved) {
      await this.store.updatePurchase(row.id, {
        state: 'failed',
        error: 'The archive could not take its place, so nothing was bought.',
      });
      if (moved) {
        throw new ArchiveRefusedError(
          'busy',
          (await this.exports.exportHoldingPlace()) ?? 'An export holds the place. Confirm again once it is done.',
        );
      }
      throw new ArchiveRefusedError('not_now', 'The archive moved on, so it cannot buy a stamp now.');
    }
    try {
      await this.relayAnswered(row.id);
    } catch (error) {
      await this.store.transition(view.id, ['buying'], { state: 'awaiting_purchase', purchaseId: null });
      throw error;
    }
    logger.info(`[Archive] ${describeActor(actor)} confirmed buying a stamp for the archive of "${view.stream_title}"`);
    this.launch(view.id);
    return this.current(actor.userId);
  }

  /**
   * Asks the manager for a recorded purchase and waits a moment for its first answer. A refusal that comes in that
   * moment is thrown with its problem: purchases the manager does not offer, another operation under way on the node,
   * or a check of the manager's. A purchase still under way, or one whose answer has not come yet, is answered as it
   * stands, and followed in the background.
   */
  private async relayAnswered(id: string): Promise<ArchivePurchaseRow> {
    const relay = this.advancePurchase(id);
    await Promise.race([relay, new Promise((resolve) => setTimeout(resolve, this.purchaseAnswerWaitMs).unref())]);
    const row = (await this.store.getPurchase(id))!;
    const busy = this.nodeBusy.delete(id);
    if (row.state !== 'failed') return row;
    const error = row.error ?? 'The purchase failed.';
    if (error === ARCHIVE_PURCHASES_NOT_OFFERED) throw new ArchiveRefusedError('purchases_not_offered', error);
    if (busy) throw new ArchiveRefusedError('not_now', error);
    throw new ArchiveRefusedError('purchase_refused', error);
  }

  /** Turns the "List only archived qualities" switch, and rewrites the stream's catalogue entry if it is listed. */
  async setListing(actor: OperatorActor, streamId: string, archivedOnly: boolean): Promise<ArchiveOptionsResponse> {
    const stream = await this.streams.findById(streamId);
    if (!stream) throw new StreamNotFoundError(streamId);
    if (archivedOnly && !stream.archived_only) {
      const rungs = await this.renditions.listByStream(streamId);
      const listed = await this.listedRenditions({ ...stream, archived_only: true });
      if (rungs.length === 0 || !listed || listed.size === 0) {
        throw new ArchiveRefusedError(
          'not_now',
          'Only a recording with several qualities, one of them archived, can list its archived qualities alone.',
        );
      }
    }
    if (stream.archived_only !== archivedOnly) {
      await this.store.setArchivedOnly(streamId, archivedOnly);
      logger.info(
        `[Archive] ${describeActor(actor)} turned "List only archived qualities" ${archivedOnly ? 'on' : 'off'} for "${stream.title}"`,
      );
      await recordAudit(this.audit, {
        actor,
        action: 'archive.listing',
        streamId: stream.id,
        topic: stream.topic,
        details: { archivedOnly },
      });
      if (stream.status === 'published' || stream.status === 'live' || stream.status === 'vod') {
        const updated = await this.streams.findById(streamId);
        // A write that fails is recorded on the row as any failed republish is, and the switch stands.
        if (updated) await this.publisher.republishWithState(actor, updated).catch(() => undefined);
      }
    }
    return this.optionsFor(streamId, actor.userId);
  }

  // --- the process's own lifecycle ---------------------------------------------

  /** At boot: carries on with a job the last process left running, and starts the watch. */
  async boot(): Promise<void> {
    try {
      const row = await this.store.getJob();
      if (row && ACTIVE.includes(row.state)) {
        logger.info(`[Archive] carrying on with the archive the last process left ${row.state}`);
        this.launch(row.id);
      }
    } catch (error) {
      logger.error(`[Archive] could not look at the archive at boot: ${getErrorMessage(error)}`);
    }
    this.watcher = setInterval(() => void this.tick(), this.watchIntervalMs);
    this.watcher.unref();
  }

  /** Stops the job after the chunks in flight, leaving it in its state, so the next start carries on with it. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    const job = this.job;
    if (job) {
      job.controller.abort();
      await job.promise.catch(() => undefined);
    }
    await this.ticking;
    // A purchase still asked of the manager is not waited for: it can take minutes, the manager journals it under its
    // id, and the next start reads where it stands.
  }

  /** Resolves once no job and no purchase look is running. For the tests. */
  async settled(): Promise<void> {
    while (this.job) await this.job.promise.catch(() => undefined);
    await Promise.all(this.advancing.values());
  }

  /**
   * One look: a waiting job whose stream is a recording again carries on, an active one with no job in this process
   * gets one, and the purchases under way are asked about. Runs on a timer, and after a user chooses Wait.
   */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        const row = await this.store.getJob();
        if (this.stopping) return;
        if (row?.state === 'waiting') {
          const stream = await this.streams.findById(row.stream_id);
          if (stream && holdsFinishedRecording({ status: stream.status, manifestIndex: stream.manifest_index })) {
            if (await this.store.transition(row.id, ['waiting'], { state: 'measuring' })) {
              logger.info(`[Archive] "${stream.title}" is a recording again; the archive carries on with it`);
              this.launch(row.id);
            }
          }
        } else if (row && ACTIVE.includes(row.state) && !this.job) {
          this.launch(row.id);
        }
        for (const purchase of await this.store.listPurchases(PURCHASES_LISTED)) {
          if (purchase.state === 'buying' || purchase.state === 'waiting_usable') {
            await this.advancePurchase(purchase.id);
          }
        }
      } catch (error) {
        logger.warn(`[Archive] could not look at the archive: ${getErrorMessage(error)}`);
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  // --- the job -------------------------------------------------------------------

  private launch(id: string): void {
    if (this.stopping) return;
    const before = this.job?.promise ?? Promise.resolve();
    const controller = new AbortController();
    const promise: Promise<void> = before
      .catch(() => undefined)
      .then(() => (controller.signal.aborted ? undefined : this.run(id, controller.signal)))
      .finally(() => {
        if (this.job?.promise === promise) this.job = null;
      });
    this.job = { id, controller, promise };
  }

  private async stopJob(id: string): Promise<void> {
    const job = this.job;
    if (!job || job.id !== id) return;
    job.controller.abort();
    await job.promise.catch(() => undefined);
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      const job = await this.store.getJob();
      if (!job || job.id !== id) return;
      try {
        switch (job.state) {
          case 'measuring':
            await this.measurePass(job, signal);
            break;
          case 'buying':
          case 'waiting_usable':
            await this.purchasePass(job, signal);
            break;
          case 'copying':
            await this.copyPass(job, signal);
            break;
          case 'verifying':
            await this.verifyPass(job, signal);
            break;
          default:
            return;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof MovedOn) continue;
        await this.pauseOn(job, error);
        return;
      }
    }
  }

  /** Pauses the job on what stopped it, and audits it. A job already moved on is left as it is. */
  private async pauseOn(job: ArchiveJobRow, error: unknown): Promise<void> {
    const { reason, message } = this.pauseFor(error);
    const paused = await this.store.transition(job.id, ACTIVE, {
      state: 'paused',
      pauseReason: reason,
      pauseMessage: message,
    });
    if (!paused) return;
    logger.warn(`[Archive] the archive paused (${reason}): ${message}`);
    await recordAudit(this.audit, {
      actor: SYSTEM_ARCHIVE,
      action: 'archive.paused',
      streamId: job.stream_id,
      details: { archiveId: job.id, reason, message, from: job.state },
    });
  }

  private pauseFor(error: unknown): { reason: Exclude<ArchivePauseReason, 'user'>; message: string } {
    if (error instanceof ArchivePause) return { reason: error.reason, message: error.message };
    if (error instanceof UnreadableChunkError || error instanceof SlotMissingError) {
      return { reason: 'unreadable', message: `${error.message} Try again, or cancel.` };
    }
    if (error instanceof ArchiveNodeError) {
      if (error.problem === 'batch_full') {
        return {
          reason: 'batch',
          message:
            'The archive stamp is full. Dilute it on the Stamps tab and try again, copy onto another stamp, or buy a new one.',
        };
      }
      if (error.problem === 'batch_unusable') {
        return {
          reason: 'batch',
          message: `${withoutCatalogueNode(error.message)} Try again, choose another stamp, or buy a new one.`,
        };
      }
      if (error.problem === 'node') {
        return {
          reason: 'node',
          message: `The catalogue node did not answer: ${withoutCatalogueNode(error.message)} Try again, or cancel.`,
        };
      }
    }
    if (error instanceof PlaylistFormatError) {
      return { reason: 'problem', message: `The recording playlist could not be read: ${error.message}` };
    }
    return { reason: 'problem', message: `The archive stopped: ${withoutCatalogueNode(getErrorMessage(error))}` };
  }

  /** Where the job carries on after a pause, from what it holds. */
  private async resumeState(job: ArchiveJobRow, items: readonly ArchiveItemRow[]): Promise<ArchiveJobState> {
    if (job.batch_id === null) {
      if (job.purchase_id) {
        const purchase = await this.store.getPurchase(job.purchase_id);
        if (purchase && purchase.state !== 'failed') {
          return purchase.state === 'waiting_usable' ? 'waiting_usable' : 'buying';
        }
      }
      return job.chunks_total === null ? 'measuring' : 'awaiting_purchase';
    }
    if (job.chunks_total === null || items.some((item) => item.chunks_total === null)) return 'measuring';
    if (items.every((item) => item.state === 'verifying' || item.state === 'done')) return 'verifying';
    return 'copying';
  }

  /** The node to copy through now, or a pause that says why there is none. */
  private async nodeNow(): Promise<{ url: string; name: string }> {
    const node = nodeOf(await this.catalogue.get());
    if ('problem' in node) throw new ArchivePause('node', node.problem);
    return node;
  }

  private async streamOf(job: ArchiveJobRow): Promise<StreamRow> {
    const stream = await this.streams.findById(job.stream_id);
    if (!stream) throw new MovedOn();
    if (stream.status === 'live') throw new ArchivePause('live', liveMessage());
    return stream;
  }

  /**
   * Measures every chosen quality: its playlist read, and each segment's root, which gives its size and erasure level
   * and so its chunks, and finds a root no longer on Swarm before any postage is spent. A quality whose recording
   * moved on since it was chosen starts over at the new one. Then the job waits for a purchase confirm, or goes on to
   * copy once the stamp has room.
   */
  private async measurePass(job: ArchiveJobRow, signal: AbortSignal): Promise<void> {
    const stream = await this.streamOf(job);
    const node = await this.nodeNow();
    const rungs = await this.renditions.listByStream(stream.id);
    const items = await this.store.items(job.id);
    let total = 0;
    for (const item of items) {
      if (item.state === 'done') {
        total += item.chunks_total ?? 0;
        continue;
      }
      const feed = this.feedOf(stream, rungs, item.rendition);
      if (!feed) {
        throw new ArchivePause(
          'problem',
          `The ${labelOf(item.rendition)} recording of "${stream.title}" is not finished.`,
        );
      }
      let started = item.posts_under_tag > 0;
      if (feed.index !== item.manifest_index || feed.topic !== item.feed_topic) {
        await this.restartItem(job.id, item, { manifestIndex: feed.index, feedTopic: feed.topic });
        started = false;
      }
      await this.store.updateItem(job.id, item.rendition, { state: 'measuring' });
      const slot = await this.copier.readSlot([node.url], feed, signal);
      const segments = [...new Set(parseRecordingPlaylist(slot.payload).segments.map((segment) => segment.reference))];
      if (segments.some((reference) => reference.length !== 64)) {
        // An encrypted reference names a key beside the address, and its chunks cannot be walked by span.
        throw new ArchivePause(
          'problem',
          `The ${labelOf(item.rendition)} recording's segments are encrypted, and an encrypted recording cannot be archived.`,
        );
      }
      let chunks = slot.chunks + (item.position === 0 && rungs.length > 0 ? 1 : 0);
      let unreadable = 0;
      await pool(segments, this.settings.parallelChunks, async (reference) => {
        try {
          const root = await this.copier.measure([node.url], reference, signal);
          chunks += treeChunks(root.bytes, root.level);
        } catch (error) {
          // Only a segment the node answered not found for is unreadable; a node that did not answer pauses with it.
          if (signal.aborted || !(error instanceof ChunkMissingError)) throw error;
          unreadable += 1;
        }
      });
      if (unreadable > 0) {
        throw new ArchivePause(
          'unreadable',
          `${unreadable} of ${segments.length} segments of the ${labelOf(item.rendition)} recording could not be read from Swarm. Try again, or cancel.`,
        );
      }
      await this.store.updateItem(job.id, item.rendition, {
        state: started ? 'copying' : 'waiting',
        segmentsTotal: segments.length,
        chunksTotal: chunks,
      });
      total += chunks;
    }
    const estimate = bzzEstimate(total);
    const measured = {
      chunksTotal: total,
      bzzEstimateLowPlur: estimate.lowPlur,
      bzzEstimateHighPlur: estimate.highPlur,
    };
    logger.info(`[Archive] measured "${stream.title}": up to ${total} chunks to copy`);
    if (job.batch_id === null) {
      if (!(await this.store.transition(job.id, ['measuring'], { state: 'awaiting_purchase', ...measured }))) {
        throw new MovedOn();
      }
      logger.info(`[Archive] the archive of "${stream.title}" waits for a user to confirm the stamp to buy`);
      return;
    }
    await this.checkRoom(job.batch_id, node.url, await this.store.items(job.id), total, signal);
    if (!(await this.store.transition(job.id, ['measuring'], { state: 'copying', ...measured }))) throw new MovedOn();
  }

  /**
   * Pauses unless the stamp can be written and has room for what is left to copy, by its bucket sum. Answers the
   * bucket sum it read.
   */
  private async checkRoom(
    batchId: string,
    url: string,
    items: readonly ArchiveItemRow[],
    total: number,
    signal: AbortSignal,
  ): Promise<number> {
    const held = heldStamps(await this.catalogue.get());
    const batch = held?.batches.find((candidate) => candidate.batchId === batchId);
    const problem = held
      ? stampProblem(batch, held.observedAt, this.now())
      : 'The manager has pushed no archive stamps.';
    if (problem || !batch || !held) {
      throw new ArchivePause(
        'batch',
        `${problem ?? 'The archive stamp is not listed.'} Choose another stamp, or buy a new one.`,
      );
    }
    const used = await this.node.bucketSum(url, batchId, signal);
    const copied = items.reduce((sum, item) => sum + item.chunks_copied, 0);
    const needed = Math.max(0, total - copied);
    const stamp = toArchiveStamp(batch, held.observedAt, used, 0, this.settings.ttlWarningDays, this.now());
    if (!archiveStampFits(stamp, needed)) {
      throw new ArchivePause(
        'batch',
        `The archive stamp ${batch.label ?? shortBatch(batchId)} has room for about ${stamp.roomChunks} more chunks, and this archive needs up to ${needed}. Dilute it and try again, choose another stamp, or buy a new one.`,
      );
    }
    return used;
  }

  /** Forgets an item's copy so far, so it starts over: its ledger, its counters and its tag. */
  private async restartItem(jobId: string, item: ArchiveItemRow, change: ArchiveItemChange = {}): Promise<void> {
    await this.store.clearSegments(jobId, item.rendition);
    await this.store.updateItem(jobId, item.rendition, {
      state: 'waiting',
      result: null,
      segmentsDone: 0,
      chunksCopied: 0,
      chunksRebuilt: 0,
      parityMissing: 0,
      bytesCopied: 0,
      postsUnderTag: 0,
      chunksSynced: 0,
      chunksSeen: 0,
      bucketSumBefore: null,
      tagUid: null,
      ...change,
    });
  }

  /**
   * Follows the job's purchase until its batch is usable and the manager lists it as writable, then copies onto it. The
   * manager may list a new batch while Bee still has it pending, so a listed batch alone is not enough.
   */
  private async purchasePass(job: ArchiveJobRow, signal: AbortSignal): Promise<void> {
    const gone = 'The purchase for this archive is gone. Choose a stamp, or buy a new one.';
    const purchaseId = job.purchase_id;
    if (!purchaseId) throw new ArchivePause('batch', gone);
    for (;;) {
      // The manager answers a purchase only once Bee has, which can take minutes: a pause or a stop does not wait for
      // it. The purchase goes on, and the next look reads where it stands.
      await Promise.race([this.advancePurchase(purchaseId), untilAborted(signal)]);
      if (signal.aborted) throw new MovedOn();
      const purchase = await this.store.getPurchase(purchaseId);
      if (!purchase) throw new ArchivePause('batch', gone);
      if (purchase.state === 'failed') {
        throw new ArchivePause(
          'problem',
          `The stamp could not be bought: ${purchase.error ?? 'the purchase failed'} Choose a stamp, or buy a new one.`,
        );
      }
      const held = purchase.batch_id === null ? null : heldStamps(await this.catalogue.get());
      const batch = held?.batches.find((candidate) => candidate.batchId === purchase.batch_id);
      // What the record says against the batch, or null while it does not list it yet.
      const problem = held && batch ? stampProblem(batch, held.observedAt, this.now()) : null;
      if (purchase.state === 'usable' && batch && problem === null) {
        const moved = await this.store.transition(job.id, ['buying', 'waiting_usable'], {
          state: 'copying',
          batchId: purchase.batch_id,
          buyNew: false,
        });
        if (!moved) throw new MovedOn();
        logger.info(`[Archive] the new stamp ${shortBatch(purchase.batch_id!)} is usable; the archive copies onto it`);
        return;
      }
      if (purchase.batch_id !== null && job.state === 'buying') {
        const moved = await this.store.transition(job.id, ['buying'], { state: 'waiting_usable' });
        if (!moved) throw new MovedOn();
        job = moved;
      }
      if (this.now() - purchase.started_at.getTime() > this.purchaseTimeoutMs) {
        const minutes = Math.round(this.purchaseTimeoutMs / 60_000);
        throw new ArchivePause(
          'batch',
          `The new stamp is not usable ${minutes} minutes after it was asked for.${problem ? ` ${problem}` : ''} Try again later, choose another stamp, or cancel.`,
        );
      }
      await sleep(this.pollMs, signal);
    }
  }

  /**
   * Copies every quality not posted yet, one after another, each under a tag of its own, segment by segment from its
   * ledger. Once every quality is posted, the job verifies.
   */
  private async copyPass(job: ArchiveJobRow, signal: AbortSignal): Promise<void> {
    if (job.batch_id === null) throw new MovedOn();
    const batchId = job.batch_id;
    const stream = await this.streamOf(job);
    const node = await this.nodeNow();
    const rungs = await this.renditions.listByStream(stream.id);
    const items = await this.store.items(job.id);
    await this.checkFunds();
    const total = items.reduce((sum, item) => sum + (item.chunks_total ?? 0), 0);
    const bucketsBefore = await this.checkRoom(batchId, node.url, items, total, signal);
    if (job.chequebook_before_plur === null && this.lastChequebook !== null) {
      const moved = await this.store.transition(job.id, ['copying'], {
        state: 'copying',
        chequebookBeforePlur: this.lastChequebook,
      });
      if (!moved) throw new MovedOn();
    }

    const started = this.now();
    let copiedThisPass = 0;
    const checks = { status: this.now(), funds: this.now() };
    const between = async () => {
      if (signal.aborted) throw new MovedOn();
      if (this.now() - checks.status >= this.statusCheckMs) {
        checks.status = this.now();
        const now = await this.streams.findById(stream.id);
        if (!now) throw new MovedOn();
        if (now.status === 'live') throw new ArchivePause('live', liveMessage());
        const current = nodeOf(await this.catalogue.get());
        if ('problem' in current || current.url !== node.url) {
          throw new ArchivePause(
            'node',
            'The manager designated another catalogue node. Try again to copy through it, or cancel.',
          );
        }
      }
      if (this.now() - checks.funds >= this.fundsCheckMs) {
        checks.funds = this.now();
        await this.checkFunds();
      }
    };

    for (const item of items) {
      if (item.state === 'verifying' || item.state === 'done') continue;
      const feed = this.feedOf(stream, rungs, item.rendition);
      if (!feed || feed.index !== item.manifest_index || feed.topic !== item.feed_topic) {
        // The stream recorded again since the job measured: measure again, and copy the new recording.
        if (!(await this.store.transition(job.id, ['copying'], { state: 'measuring' }))) throw new MovedOn();
        throw new MovedOn();
      }
      const { counters, tagUid } = await this.tagFor(job.id, item, node.url, signal);
      if (item.state === 'waiting' || item.bucket_sum_before === null) {
        await this.store.updateItem(job.id, item.rendition, { state: 'copying', bucketSumBefore: bucketsBefore });
        await this.store.startArchive({
          stream_id: stream.id,
          rendition: item.rendition,
          batch_id: batchId,
          feed_owner: item.feed_owner,
          feed_topic: item.feed_topic,
          manifest_index: item.manifest_index,
          parity_missing: counters.parityMissing,
          segments: item.segments_done,
          chunks: counters.chunks,
          bytes: counters.bytes,
          chunks_rebuilt: counters.rebuilt,
          bucket_sum_before: bucketsBefore,
          bucket_sum_after: null,
          bzz_spent_estimate_plur: null,
        });
      }
      const ctx: CopyContext = {
        writer: node.url,
        readers: [node.url],
        batchId,
        tagUid,
        signal,
        parallel: this.settings.parallelChunks,
        admit: this.pushWindow(node.url, tagUid, counters, signal),
        counters,
      };

      // The slots are posted on every pass, since the playlist names the segments, and counted under the tag each time.
      // What they hold is counted once: saved counters with chunks in them were saved with a segment, slots included.
      const slotsCounted = counters.chunks > 0;
      const held = { ...counters };
      // The master playlist's slot, with the first quality: it names every quality, and stays as the stage signed it.
      // The stream card's frame goes with it.
      if (item.position === 0 && rungs.length > 0 && stream.manifest_index !== null) {
        const master = await this.copier.copySlot(ctx, {
          owner: stream.owner,
          topic: stream.topic,
          index: stream.manifest_index,
        });
        await this.copyFrame(ctx, stream, rungs, master);
      }
      const payload = await this.copier.copySlot(ctx, feed);
      if (slotsCounted) {
        counters.chunks = held.chunks;
        counters.bytes = held.bytes;
        counters.rebuilt = held.rebuilt;
        counters.parityMissing = held.parityMissing;
      }
      const segments = [...new Set(parseRecordingPlaylist(payload).segments.map((segment) => segment.reference))];
      const done = await this.store.segmentsDone(job.id, item.rendition);
      let segmentsDone = done.size;
      for (const reference of segments) {
        if (done.has(reference)) continue;
        await between();
        const before = counters.chunks;
        const copied = await this.copier.copyTree(ctx, reference);
        segmentsDone += 1;
        copiedThisPass += counters.chunks - before;
        await this.store.recordSegment(
          job.id,
          item.rendition,
          { reference, chunks: copied.chunks, bytes: copied.bytes, parityMissing: copied.parityMissing },
          this.itemCounters(counters, segmentsDone, segments.length),
        );
        const seconds = (this.now() - started) / 1000;
        if (seconds >= 1) {
          await this.store.transition(job.id, ['copying'], {
            state: 'copying',
            chunksPerSecond: copiedThisPass / seconds,
          });
        }
      }
      await this.store.updateItem(job.id, item.rendition, {
        ...this.itemCounters(counters, segmentsDone, segments.length),
        state: 'verifying',
      });
      await this.store.saveArchive(stream.id, item.rendition, {
        parity_missing: counters.parityMissing,
        segments: segments.length,
        chunks: counters.chunks,
        bytes: counters.bytes,
        chunks_rebuilt: counters.rebuilt,
      });
      logger.info(
        `[Archive] posted every chunk of "${stream.title}" at ${labelOf(item.rendition)}: ${counters.chunks} chunks`,
      );
    }
    if (!(await this.store.transition(job.id, ['copying'], { state: 'verifying' }))) throw new MovedOn();
  }

  /**
   * The stream card's frame, which the viewer takes from the quality the master playlist lists first: that quality's
   * playlist slot and its first segment that is not a gap, posted under the first quality's tag on every pass, whether
   * or not that quality is one of the job's own. A chunk posted again under the same stamp takes no more room. The
   * frame stays outside the quality's counts, its posts aside, which the tag counts. A frame that cannot be copied is
   * said in the log and left out, and the job's own qualities still complete.
   */
  private async copyFrame(
    ctx: CopyContext,
    stream: StreamRow,
    rungs: readonly StreamRenditionRow[],
    master: string,
  ): Promise<void> {
    const topic = firstVariantTopic(master);
    const rung = topic === null ? undefined : rungs.find((candidate) => candidate.topic === topic);
    const before = { ...ctx.counters };
    try {
      const feed = rung ? this.feedOf(stream, rungs, rung.name) : null;
      if (!feed) {
        throw new Error(
          rung
            ? `the ${labelOf(rung.name)} recording it is taken from is not finished`
            : 'the master playlist names no recorded quality first',
        );
      }
      const [first] = parseRecordingPlaylist(await this.copier.copySlot(ctx, feed)).segments;
      if (!first) throw new Error('its playlist names no segment');
      await this.copier.copyTree(ctx, first.reference);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      logger.warn(`[Archive] the card frame of "${stream.title}" is not copied: ${getErrorMessage(error)}`);
    } finally {
      Object.assign(ctx.counters, { ...before, posts: ctx.counters.posts });
    }
  }

  private itemCounters(counters: CopyCounters, segmentsDone: number, segmentsTotal: number): ArchiveItemChange {
    return {
      segmentsDone,
      segmentsTotal,
      chunksCopied: counters.chunks,
      bytesCopied: counters.bytes,
      chunksRebuilt: counters.rebuilt,
      parityMissing: counters.parityMissing,
      postsUnderTag: counters.posts,
    };
  }

  /**
   * The item's tag and counters to carry on with. With no tag yet, a new one. A tag the node forgot, or one that
   * counts fewer posts than the job made, means the node lost track of the copy: a new tag, and the quality copied
   * again from the start, which costs pushes and no room. A tag that counts more posts than the job saved holds the
   * posts a stopped process made before it could save them, so they are taken as made.
   */
  private async tagFor(
    jobId: string,
    item: ArchiveItemRow,
    url: string,
    signal: AbortSignal,
  ): Promise<{ counters: CopyCounters; tagUid: number }> {
    const counters: CopyCounters = {
      posts: item.posts_under_tag,
      chunks: item.chunks_copied,
      bytes: item.bytes_copied,
      rebuilt: item.chunks_rebuilt,
      parityMissing: item.parity_missing,
    };
    if (item.tag_uid !== null) {
      const tag = await this.node.readTag(url, item.tag_uid, signal);
      if (tag && tag.split >= item.posts_under_tag) {
        if (tag.split > counters.posts) {
          counters.posts = tag.split;
          await this.store.updateItem(jobId, item.rendition, { postsUnderTag: tag.split });
        }
        return { counters, tagUid: item.tag_uid };
      }
      logger.warn(
        `[Archive] the node lost track of the ${labelOf(item.rendition)} copy's tag; it is copied again under a new one`,
      );
      await this.restartItem(jobId, item, {
        state: item.state,
        bucketSumBefore: item.bucket_sum_before,
        chunksTotal: item.chunks_total,
        segmentsTotal: item.segments_total,
      });
      Object.assign(counters, emptyCounters());
    }
    const uid = await this.node.createTag(url, signal);
    await this.store.updateItem(jobId, item.rendition, { tagUid: uid, postsUnderTag: 0 });
    counters.posts = 0;
    return { counters, tagUid: uid };
  }

  /**
   * The push window of one quality's copy: before a post, the posts under its tag that Bee has not pushed yet, by its
   * last reading and the posts made since, stay under `ARCHIVE_PUSH_WINDOW_CHUNKS`. Past it, the tag is read until
   * Bee catches up, and a tag that pushes nothing for the stall time pauses the job.
   */
  private pushWindow(url: string, tagUid: number, counters: CopyCounters, signal: AbortSignal): () => Promise<void> {
    const window = this.settings.pushWindowChunks;
    let accounted = counters.posts;
    let reading: Promise<void> | null = null;
    let lastProgress = { value: -1, at: this.now() };
    const read = async () => {
      const tag = await this.node.readTag(url, tagUid, signal);
      if (!tag) {
        throw new ArchivePause(
          'problem',
          "The catalogue node forgot the copy's tag. Try again to copy the quality again.",
        );
      }
      // Posts the node has counted, less those it has not pushed, plus posts made since the reading.
      accounted = tag.synced + tag.seen + Math.max(0, counters.posts - tag.split);
      const progress = tag.synced + tag.seen;
      if (progress !== lastProgress.value) lastProgress = { value: progress, at: this.now() };
      else if (this.now() - lastProgress.at > this.tagStallMs)
        throw new ArchivePause('problem', stalledMessage(this.tagStallMs));
    };
    return async () => {
      while (counters.posts - accounted >= window) {
        reading ??= read().finally(() => {
          reading = null;
        });
        await reading;
        if (counters.posts - accounted >= window) await sleep(this.pollMs, signal);
      }
    };
  }

  /**
   * Waits until Bee reports every post of every quality pushed: a quality is complete when its tag's `split` equals
   * the posts the job made under it and `synced` plus `seen` equals `split`. A post Bee found still queued from an
   * earlier post of the same chunk counts as `seen`, and syncs with that one.
   */
  private async verifyPass(job: ArchiveJobRow, signal: AbortSignal): Promise<void> {
    const node = await this.nodeNow();
    const stream = await this.streams.findById(job.stream_id);
    if (!stream) throw new MovedOn();
    const progress = new Map<string, { value: number; at: number }>();
    for (;;) {
      const items = await this.store.items(job.id);
      const open = items.filter((item) => item.state === 'verifying');
      if (items.every((item) => item.state === 'done')) break;
      if (open.length === 0) {
        if (!(await this.store.transition(job.id, ['verifying'], { state: 'copying' }))) throw new MovedOn();
        return;
      }
      for (const item of open) {
        const tag = item.tag_uid === null ? null : await this.node.readTag(node.url, item.tag_uid, signal);
        if (!tag || tag.split < item.posts_under_tag) {
          logger.warn(
            `[Archive] the node lost track of the ${labelOf(item.rendition)} copy's tag; it is copied again under a new one`,
          );
          await this.restartItem(job.id, item, {
            state: 'copying',
            bucketSumBefore: item.bucket_sum_before,
            chunksTotal: item.chunks_total,
            segmentsTotal: item.segments_total,
          });
          if (!(await this.store.transition(job.id, ['verifying'], { state: 'copying' }))) throw new MovedOn();
          return;
        }
        // Posts a stopped process made before it could save them are the tag's own count.
        const posts = Math.max(item.posts_under_tag, tag.split);
        await this.store.updateItem(job.id, item.rendition, {
          chunksSynced: tag.synced,
          chunksSeen: tag.seen,
          postsUnderTag: posts,
        });
        if (tagComplete(tag, posts)) {
          await this.completeItem(job, stream, item, node.url, signal);
          continue;
        }
        const reached = tag.synced + tag.seen;
        const last = progress.get(item.rendition);
        if (!last || last.value !== reached) progress.set(item.rendition, { value: reached, at: this.now() });
        else if (this.now() - last.at > this.tagStallMs)
          throw new ArchivePause('problem', stalledMessage(this.tagStallMs));
      }
      if ((await this.store.items(job.id)).some((item) => item.state === 'verifying')) await sleep(this.pollMs, signal);
    }
    await this.finish(job, stream);
  }

  private async completeItem(
    job: ArchiveJobRow,
    stream: StreamRow,
    item: ArchiveItemRow,
    url: string,
    signal: AbortSignal,
  ): Promise<void> {
    const result = item.parity_missing > 0 ? 'reduced' : 'complete';
    const after = await this.node.bucketSum(url, job.batch_id!, signal).catch(() => null);
    await this.store.updateItem(job.id, item.rendition, { state: 'done', result });
    if (after !== null) await this.store.saveArchive(stream.id, item.rendition, { bucket_sum_after: after });
    await this.store.completeArchive(stream.id, item.rendition, job.started_by_user_id, job.started_by);
    logger.info(
      `[Archive] "${stream.title}" at ${labelOf(item.rendition)} is archived on stamp ${shortBatch(job.batch_id!)}${
        result === 'reduced' ? `, with ${item.parity_missing} parity chunks missing` : ''
      }`,
    );
    await recordAudit(this.audit, {
      actor: SYSTEM_ARCHIVE,
      action: 'archive.quality.done',
      streamId: stream.id,
      topic: stream.topic,
      details: {
        archiveId: job.id,
        rendition: item.rendition,
        batchId: job.batch_id,
        result,
        chunks: item.chunks_copied,
        bytes: item.bytes_copied,
        parityMissing: item.parity_missing,
        chunksRebuilt: item.chunks_rebuilt,
        bucketSumBefore: item.bucket_sum_before,
        bucketSumAfter: after,
      },
    });
  }

  private async finish(job: ArchiveJobRow, stream: StreamRow): Promise<void> {
    const current = (await this.store.getJob()) ?? job;
    const chequebookAfter = await this.readChequebook().catch(() => null);
    const spent = plurMinus(current.chequebook_before_plur, chequebookAfter);
    const items = await this.store.items(job.id);
    const total = items.reduce((sum, item) => sum + item.chunks_copied, 0);
    if (spent !== null && total > 0) {
      for (const item of items) {
        const share = ((BigInt(spent) * BigInt(item.chunks_copied)) / BigInt(total)).toString();
        await this.store.saveArchive(stream.id, item.rendition, { bzz_spent_estimate_plur: share });
      }
    }
    if (current.chunks_per_second) await this.store.saveRate(current.chunks_per_second);
    const done = await this.store.transition(job.id, ['verifying'], { state: 'done', bzzSpentPlur: spent });
    if (!done) throw new MovedOn();
    logger.info(`[Archive] the archive of "${stream.title}" is done`);
    await recordAudit(this.audit, {
      actor: SYSTEM_ARCHIVE,
      action: 'archive.done',
      streamId: stream.id,
      topic: stream.topic,
      details: {
        archiveId: job.id,
        batchId: job.batch_id,
        renditions: items.map((item) => ({ rendition: item.rendition, result: item.result })),
        chunks: total,
        bzzSpentPlur: spent,
      },
    });
  }

  // --- funds and purchases ---------------------------------------------------------

  /** What the catalogue node's chequebook can pay, as the manager reads it, or null when it cannot be read. */
  private async readChequebook(): Promise<string | null> {
    if (!this.manager) return null;
    const inventory = await this.manager.inventory();
    const available = inventory.catalogue?.chequebook?.availablePlur ?? null;
    this.lastChequebook = available;
    return available;
  }

  /**
   * Pauses for funds when the catalogue node's chequebook can pay less than the floor. Unread, it passes, and says why
   * in the log, once until the reason changes, since the check runs every minute of a copy.
   */
  private async checkFunds(): Promise<void> {
    const floor = BigInt(this.settings.chequebookFloorPlur);
    if (floor === 0n) return;
    let available: string | null = null;
    let skipped: string | null = null;
    if (!this.manager) {
      skipped = 'funding is not set up';
    } else {
      try {
        available = await this.readChequebook();
        if (available === null) skipped = "the manager's inventory reads no chequebook on the catalogue node";
      } catch (error) {
        skipped = `the catalogue node's chequebook could not be read: ${getErrorMessage(error)}`;
      }
    }
    if (skipped !== null || available === null) {
      if (skipped !== this.fundsSkipped) logger.warn(`[Archive] the funds check is skipped: ${skipped}`);
      this.fundsSkipped = skipped;
      return;
    }
    this.fundsSkipped = null;
    if (BigInt(available) < floor) {
      throw new ArchivePause(
        'funds',
        "The catalogue node's chequebook is under the floor the archive keeps, and it pays the node's peers for every chunk read and pushed. Deposit into it on the Chequebooks tab, then try again.",
      );
    }
  }

  /** What a buy dialog needs, read from the manager's inventory, or the sentence that says why none can be bought. */
  private async buyTerms(
    fresh = true,
  ): Promise<{ terms: ArchiveBuyTerms | null; problem: string | null; nodeId: string | null }> {
    if (!this.manager) {
      return { terms: null, problem: 'Funding is not set up, so no archive stamp can be bought.', nodeId: null };
    }
    let inventory: FundingInventory;
    try {
      inventory = await this.inventory(fresh);
    } catch (error) {
      return {
        terms: null,
        problem: `The manager could not be read, so no archive stamp can be bought now: ${getErrorMessage(error)}`,
        nodeId: null,
      };
    }
    const node = inventory.catalogue;
    if (!node) {
      return { terms: null, problem: 'The manager has designated no catalogue node to buy a stamp on.', nodeId: null };
    }
    this.lastChequebook = node.chequebook?.availablePlur ?? this.lastChequebook;
    return {
      terms: {
        postage: inventory.chain.postage ?? null,
        walletXbzzPlur: node.xbzzPlur,
        walletXdaiWei: node.xdaiWei,
        defaultDays: this.settings.buyDefaultDays,
        minimumDays: ARCHIVE_BUY_MIN_DAYS,
      },
      problem: null,
      nodeId: node.nodeId,
    };
  }

  /**
   * The manager's inventory: read now, or, for what the widget and the Stamps tab read every few seconds, the last
   * reading while it is younger than {@link INVENTORY_REUSE_MS}. A purchase and the funds check read it fresh.
   */
  private async inventory(fresh: boolean): Promise<FundingInventory> {
    if (!this.manager) throw new Error('Funding is not set up.');
    const kept = this.inventoryRead;
    if (!fresh && kept && this.now() - kept.at < INVENTORY_REUSE_MS) return kept.inventory;
    const inventory = await this.manager.inventory();
    this.inventoryRead = { at: this.now(), inventory };
    return inventory;
  }

  /** Checks a buy choice and records the purchase, before the manager is asked. */
  private async newPurchase(
    actor: OperatorActor,
    choice: ArchiveBuyChoice,
    chunksNeeded: number | null,
  ): Promise<ArchivePurchaseRow> {
    const buy = await this.buyTerms();
    if (!buy.terms) throw new ArchiveRefusedError('purchase_refused', buy.problem ?? 'No stamp can be bought now.');
    const problem = archiveBuyProblem(choice, buy.terms, chunksNeeded);
    const postage = buy.terms.postage;
    const priced =
      postage &&
      archiveEffectiveChunks(choice.depth) > 0 &&
      Number.isSafeInteger(choice.days) &&
      choice.days >= ARCHIVE_BUY_MIN_DAYS
        ? archiveBuyAmountPerChunkPlur(choice.days, postage)
        : null;
    if (problem) {
      // The price moved since the dialog priced the stamp: refused with the new cost, so what is spent is confirmed.
      const moved = priced !== null && archiveBatchCostPlur(choice.depth, priced) !== choice.costPlur;
      throw new ArchiveRefusedError(
        moved && problem.startsWith('The price of postage moved') ? 'price_moved' : 'purchase_refused',
        problem,
      );
    }
    const label = choice.label?.trim() || null;
    if (label !== null && label.length > 64) {
      throw new ArchiveRefusedError('purchase_refused', 'A stamp label is 64 characters at most.');
    }
    const row = await this.store.createPurchase({
      id: randomUUID(),
      depth: choice.depth,
      days: choice.days,
      amountPerChunkPlur: priced!,
      costPlur: choice.costPlur,
      label,
      startedByUserId: actor.userId,
      startedBy: describeActor(actor),
    });
    if (!row)
      throw new ArchiveRefusedError('not_now', 'A purchase is under way. One archive stamp is bought at a time.');
    logger.info(
      `[Archive] ${describeActor(actor)} asked for an archive stamp of depth ${row.depth}${label ? ` labelled "${label}"` : ''}`,
    );
    await recordAudit(this.audit, {
      actor,
      action: 'archive.purchase.request',
      details: {
        purchaseId: row.id,
        depth: row.depth,
        days: row.days,
        amountPerChunkPlur: row.amount_per_chunk_plur,
        costPlur: row.cost_plur,
        label,
      },
    });
    return row;
  }

  /**
   * Moves a purchase on: asks the manager for it once, then reads where it stands, until its batch is usable or it
   * failed. One look at a time per purchase. The manager journals each request id and never buys twice for one.
   */
  private advancePurchase(id: string): Promise<void> {
    const running = this.advancing.get(id);
    if (running) return running;
    const work = this.advanceOnce(id)
      .catch((error: unknown) =>
        logger.warn(`[Archive] could not ask the manager about a purchase: ${getErrorMessage(error)}`),
      )
      .finally(() => this.advancing.delete(id));
    this.advancing.set(id, work);
    return work;
  }

  private async advanceOnce(id: string): Promise<void> {
    const row = await this.store.getPurchase(id);
    if (!row || row.state === 'usable' || row.state === 'failed' || !this.manager) return;
    if (row.relayed_at === null) {
      const buy = await this.buyTerms();
      if (!buy.nodeId) return;
      // Marked first: a process that stops after the manager took it reads where it stands, rather than asking again.
      await this.store.updatePurchase(id, { relayed: true });
      try {
        const answer = await this.manager.stampPurchase({
          requestId: row.id,
          nodeId: buy.nodeId,
          depth: row.depth,
          amountPerChunkPlur: row.amount_per_chunk_plur,
          label: row.label,
        });
        if (answer.state === 'failed') {
          // The answer carries no reason; the status route carries Bee's words, when there are any.
          const words = await this.manager
            .stampPurchaseStatus(id)
            .then((status) => status.error?.trim() || null)
            .catch(() => null);
          await this.settlePurchase(row, { state: 'failed', error: words ?? 'The node did not buy the stamp.' });
          return;
        }
        if (answer.batchId) {
          await this.store.updatePurchase(id, {
            state: 'waiting_usable',
            batchId: normalBatch(answer.batchId),
            txHash: answer.txHash,
          });
        }
      } catch (error) {
        // A refusal the manager answered with: nothing was bought. A lost answer is read on the status route. A
        // manager older than archive stamps has no purchase route, and another operation on the node answers 409, in
        // the manager's own sentence when it gives one.
        if (
          error instanceof ManagerFundingError &&
          error.status !== null &&
          error.status >= 400 &&
          error.status < 500
        ) {
          const busy = error.code === 'conflict';
          if (busy) this.nodeBusy.add(id);
          const why =
            error.status === 404 && error.code !== 'unknown_node'
              ? ARCHIVE_PURCHASES_NOT_OFFERED
              : busy
                ? error.message.trim() || NODE_BUSY
                : error.message;
          await this.settlePurchase(row, { state: 'failed', error: why });
          return;
        }
        throw error;
      }
      return;
    }
    let status;
    try {
      status = await this.manager.stampPurchaseStatus(id);
    } catch (error) {
      if (error instanceof ManagerFundingError && error.code === 'unknown_request') {
        // The manager never received it, so the next look asks again, under the same id.
        await this.store.updatePurchase(id, { relayed: false });
        return;
      }
      throw error;
    }
    if (status.state === 'failed') {
      await this.settlePurchase(row, { state: 'failed', error: status.error ?? 'The purchase failed.' });
      return;
    }
    if (status.batchId) {
      const batchId = normalBatch(status.batchId);
      if (status.usable) {
        await this.settlePurchase(row, { state: 'usable', batchId, txHash: status.txHash });
        return;
      }
      await this.store.updatePurchase(id, { state: 'waiting_usable', batchId, txHash: status.txHash });
    }
  }

  private async settlePurchase(
    row: ArchivePurchaseRow,
    change: { state: 'usable' | 'failed'; batchId?: string; txHash?: string | null; error?: string },
  ): Promise<void> {
    const updated = await this.store.updatePurchase(row.id, change);
    if (!updated) return;
    if (change.state === 'usable') {
      logger.info(`[Archive] the archive stamp ${shortBatch(updated.batch_id!)} is bought and usable`);
    } else {
      logger.warn(`[Archive] the archive stamp purchase failed: ${change.error}`);
    }
    await recordAudit(this.audit, {
      actor: SYSTEM_ARCHIVE,
      action: change.state === 'usable' ? 'archive.purchase.usable' : 'archive.purchase.failed',
      details: { purchaseId: row.id, batchId: updated.batch_id, txHash: updated.tx_hash, error: updated.error },
    });
  }

  private async useStamp(
    actor: OperatorActor,
    view: ArchiveJobView,
    rawBatchId: string,
    notNow: () => ArchiveRefusedError,
  ): Promise<void> {
    const batchId = normalBatch(rawBatchId);
    const held = heldStamps(await this.catalogue.get());
    const batch = held?.batches.find((candidate) => candidate.batchId === batchId);
    const problem = held
      ? stampProblem(batch, held.observedAt, this.now())
      : 'The manager has pushed no archive stamps.';
    if (problem) throw new ArchiveRefusedError(batch ? 'stamp_unusable' : 'no_stamp', problem);
    if (batchId !== view.batch_id) {
      // What was posted onto another stamp does not count on this one: every quality not done starts over.
      for (const item of await this.store.items(view.id)) {
        if (item.state === 'done') continue;
        await this.restartItem(view.id, item, { chunksTotal: item.chunks_total, segmentsTotal: item.segments_total });
      }
    }
    const next: ArchiveJobState = view.chunks_total === null ? 'measuring' : 'copying';
    const change: ArchiveJobChange = { state: next, batchId, buyNew: false, purchaseId: null };
    const from: ArchiveJobState[] = ['awaiting_purchase', 'paused'];
    const takes = view.state === 'awaiting_purchase' || view.pause_reason === 'user';
    const moved = takes
      ? await this.store.transitionTakingPlace(view.id, from, change)
      : await this.store.transition(view.id, from, change);
    if (moved && 'refused' in moved) {
      throw new ArchiveRefusedError('busy', (await this.exports.exportHoldingPlace()) ?? 'An export holds the place.');
    }
    if (!moved) throw notNow();
    logger.info(
      `[Archive] ${describeActor(actor)} chose stamp ${shortBatch(batchId)} for the archive of "${view.stream_title}"`,
    );
    await recordAudit(this.audit, {
      actor,
      action: 'archive.use_stamp',
      streamId: view.stream_id,
      details: { archiveId: view.id, batchId, previousBatchId: view.batch_id },
    });
    this.launch(view.id);
  }

  // --- what the panel is told -------------------------------------------------------

  private feedOf(
    stream: StreamRow,
    rungs: readonly StreamRenditionRow[],
    rendition: string,
  ): { owner: string; topic: string; index: number } | null {
    if (rendition === SOURCE_RENDITION) {
      return rungs.length === 0 && stream.manifest_index !== null
        ? { owner: stream.owner, topic: stream.topic, index: stream.manifest_index }
        : null;
    }
    const rung = rungs.find((candidate) => candidate.name === rendition);
    return rung && rung.manifest_index !== null
      ? { owner: stream.owner, topic: rung.topic, index: rung.manifest_index }
      : null;
  }

  private qualitiesOf(
    stream: StreamRow,
    rungs: readonly StreamRenditionRow[],
    copies: readonly StreamArchiveRow[],
    held: ArchiveStampsHeld | null,
    now: number,
    rate: number | null,
  ): ArchiveQuality[] {
    const options =
      rungs.length > 0
        ? [...rungs]
            .sort((a, b) => b.height - a.height)
            .map((rung) => {
              const bitrate = rung.avg_bandwidth > 0 ? rung.avg_bandwidth : rung.bandwidth;
              return {
                rendition: rung.name,
                width: rung.width as number | null,
                height: rung.height as number | null,
                durationSeconds: rung.duration_seconds,
                index: rung.manifest_index,
                bytes:
                  rung.duration_seconds !== null && bitrate > 0
                    ? Math.round((bitrate * rung.duration_seconds) / 8)
                    : null,
              };
            })
        : [
            {
              rendition: SOURCE_RENDITION,
              width: null,
              height: null,
              durationSeconds: stream.duration_seconds,
              index: stream.manifest_index,
              bytes: null as number | null,
            },
          ];
    return options.map((option) => {
      const copy = copies.find((candidate) => candidate.rendition === option.rendition);
      const state = qualityState(copy, option.index, held, now);
      const batch = copy ? held?.batches.find((candidate) => candidate.batchId === copy.batch_id) : undefined;
      const estimatedChunks =
        option.bytes === null ? null : Math.ceil(Math.ceil(option.bytes / 4096) * PARITY_ESTIMATE);
      const estimate = estimatedChunks === null ? null : bzzEstimate(estimatedChunks);
      const unavailable =
        option.index === null
          ? 'This quality has not finished recording.'
          : isArchived(state)
            ? 'This quality is archived at its recording already.'
            : null;
      return {
        rendition: option.rendition,
        label: labelOf(option.rendition),
        width: option.width,
        height: option.height,
        durationSeconds: option.durationSeconds,
        state,
        batchId: copy?.batch_id ?? null,
        batchLabel: batch?.label ?? null,
        chunks: copy ? copy.chunks : null,
        bytes: copy ? copy.bytes : null,
        parityMissing: copy?.parity_missing ?? 0,
        completedAt: copy?.completed_at?.toISOString() ?? null,
        completedBy: copy?.completed_by ?? null,
        estimatedChunks,
        estimatedBytes: option.bytes === null ? null : Math.ceil(option.bytes * PARITY_ESTIMATE),
        estimatedBzzLowPlur: estimate?.lowPlur ?? null,
        estimatedBzzHighPlur: estimate?.highPlur ?? null,
        estimatedSeconds: estimatedChunks !== null && rate ? Math.round(estimatedChunks / rate) : null,
        unavailable,
      };
    });
  }

  private async refusalFor(
    stream: StreamRow,
    qualities: readonly ArchiveQuality[],
    catalogueRow: CatalogueStampRow | null,
    view: ArchiveJobView | null,
  ): Promise<ArchiveRefusal | null> {
    if (!holdsFinishedRecording({ status: stream.status, manifestIndex: stream.manifest_index })) {
      return {
        problem: 'not_finished',
        message: `Only a finished recording can be archived, and this stream is ${statusWords(stream.status)}.`,
      };
    }
    if (view && view.state !== 'done') return { problem: 'busy', message: busyMessage(view) };
    const exportBusy = await this.exports.exportHoldingPlace();
    if (exportBusy) return { problem: 'busy', message: exportBusy };
    const node = nodeOf(catalogueRow);
    if ('problem' in node) return { problem: 'no_node', message: node.problem };
    if (qualities.every((quality) => quality.unavailable !== null)) {
      return {
        problem: 'nothing_to_archive',
        message: 'Every quality of this recording is archived at its recording already, or has not finished.',
      };
    }
    return null;
  }

  /** The archive stamps with their room. Each stamp's bucket sum is read from the node; one it does not answer is null. */
  /**
   * The stamp an archive waiting for a purchase proposes: the smallest depth that holds its chunks with the margin,
   * for the default days, what that costs at the price now, and what the catalogue node's wallet lacks of it.
   */
  private async proposalFor(chunkCount: number): Promise<ArchivePurchaseProposal> {
    const days = this.settings.buyDefaultDays;
    const terms = (await this.buyTerms(false)).terms ?? {
      postage: null,
      walletXbzzPlur: null,
      walletXdaiWei: null,
      defaultDays: days,
      minimumDays: ARCHIVE_BUY_MIN_DAYS,
    };
    const depth = smallestArchiveDepthFor(chunkCount);
    const costPlur =
      depth !== null && terms.postage
        ? archiveBatchCostPlur(depth, archiveBuyAmountPerChunkPlur(days, terms.postage))
        : null;
    return {
      chunkCount,
      depth,
      days,
      costPlur,
      shortfallPlur: costPlur === null ? null : archiveWalletShortfallPlur(costPlur, terms.walletXbzzPlur),
      terms,
    };
  }

  private async stampsOf(
    catalogueRow: CatalogueStampRow | null,
    held: ArchiveStampsHeld,
    copies: readonly StreamArchiveRow[],
  ): Promise<ArchiveStamp[]> {
    const node = nodeOf(catalogueRow);
    const now = this.now();
    // Each stamp's holder, as the manager's inventory names it; unread, no stamp names one.
    const listed = this.manager ? ((await this.inventory(false).catch(() => null))?.archiveBatches ?? []) : [];
    return Promise.all(
      held.batches.map(async (batch: CatalogueArchiveBatch) => {
        const used =
          'problem' in node || !batch.writable
            ? null
            : await this.node.bucketSum(node.url, batch.batchId, AbortSignal.timeout(10_000)).catch(() => null);
        const qualities = copies.filter((copy) => copy.batch_id === batch.batchId && copy.state === 'complete').length;
        const holder = listed.find((one) => one.batchId.replace(/^0x/i, '').toLowerCase() === batch.batchId);
        return toArchiveStamp(
          batch,
          held.observedAt,
          used,
          qualities,
          this.settings.ttlWarningDays,
          now,
          holder ? { nodeId: holder.nodeId, nodeLabel: holder.nodeLabel } : null,
        );
      }),
    );
  }

  private async summaryOf(view: ArchiveJobView, userId: string | null): Promise<ArchiveJobSummary> {
    const items = await this.store.items(view.id);
    const held = heldStamps(await this.catalogue.get());
    const purchase = view.purchase_id ? await this.store.getPurchase(view.purchase_id) : null;
    const rate = view.chunks_per_second ?? (await this.store.lastRate());
    const copied = items.reduce((sum, item) => sum + item.chunks_copied, 0);
    const chunksTotal = items.every((item) => item.chunks_total !== null)
      ? items.reduce((sum, item) => sum + (item.chunks_total ?? 0), 0)
      : null;
    const left = chunksTotal === null ? null : Math.max(0, chunksTotal - copied);
    const proposal =
      view.state === 'awaiting_purchase' && view.chunks_total !== null
        ? await this.proposalFor(view.chunks_total)
        : null;
    return {
      id: view.id,
      streamId: view.stream_id,
      streamTitle: view.stream_title,
      state: view.state,
      pauseReason: view.pause_reason,
      pauseMessage: view.pause_message,
      pausedAt: view.paused_at?.toISOString() ?? null,
      holdsPlace: archiveHoldsPlace(view.state, view.pause_reason),
      target:
        view.batch_id !== null
          ? {
              kind: 'stamp',
              batchId: view.batch_id,
              label: held?.batches.find((batch) => batch.batchId === view.batch_id)?.label ?? null,
            }
          : { kind: 'purchase', purchase: purchase ? toPurchase(purchase) : null },
      proposal,
      items: items.map((item): ArchiveJobItem => ({
        rendition: item.rendition,
        label: labelOf(item.rendition),
        state: item.state,
        result: item.result,
        segmentsTotal: item.segments_total,
        segmentsDone: item.segments_done,
        chunksTotal: item.chunks_total,
        chunksCopied: item.chunks_copied,
        chunksRebuilt: item.chunks_rebuilt,
        parityMissing: item.parity_missing,
        chunksSynced: item.chunks_synced + item.chunks_seen,
        postsMade: item.posts_under_tag,
        bytesCopied: item.bytes_copied,
      })),
      chunksTotal,
      chunksCopied: copied,
      bytesCopied: items.reduce((sum, item) => sum + item.bytes_copied, 0),
      chunksPerSecond: view.chunks_per_second,
      secondsLeft: left === null || !rate || view.state === 'done' ? null : Math.round(left / rate),
      bzzEstimateLowPlur: view.bzz_estimate_low_plur,
      bzzEstimateHighPlur: view.bzz_estimate_high_plur,
      chequebookAvailablePlur: this.lastChequebook,
      bzzSpentPlur: view.bzz_spent_plur,
      startedBy: view.started_by,
      startedByYou: userId !== null && view.started_by_user_id === userId,
      startedAt: view.started_at.toISOString(),
      finishedAt: view.finished_at?.toISOString() ?? null,
      dismissed: view.dismissed,
      actions: archiveActionsFor(view, view.dismissed),
    };
  }
}

/** Resolves once the signal aborts; never before. */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
