import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  RECORDING_CHECK_MIN_PEERS,
  RECORDING_CHECK_ROUND_GAP_SECONDS,
  RECORDING_CHECK_ROUNDS,
  RECORDING_CHECK_VALID_SECONDS,
  recordingSkipReason,
  recordingVerdict,
  type CheckedRecording,
  type LostRecordingsRemovalRequest,
  type LostRecordingsRemovalResponse,
  type RecordingCheck,
  type RecordingCheckResponse,
  type RecordingSkipReason,
  type RemovedRecording,
  type StreamStatus,
} from '@streaming-monorepo/web2-admin-common';

import type { StreamRenditionRow, StreamRow } from '../../types/index.js';
import { getErrorMessage } from '../../utils/errorUtils.js';
import { describeActor, describeStream, type Actor, type OperatorActor } from '../actor.js';
import { recordAudit, type AuditLog } from '../AuditLog.js';
import { withoutCatalogueNode } from '../catalogueNodeText.js';
import type { ReadNode } from '../export/RecordingSource.js';
import type { CatalogueTarget } from '../FeedGateway.js';
import { Logger } from '../Logger.js';
import { Mutex } from '../Mutex.js';

import type {
  RecordingCheckRow,
  RecordingCheckStore,
  RecordingCheckStreamRow,
  StreamVerdict,
} from './RecordingCheckRepository.js';
import {
  failedQualitiesOf,
  lostInOneRead,
  readRecordingRound,
  recordingJudgeInputOf,
  recordingPartsOf,
  stillUnread,
  type RecordingReads,
} from './recordingReads.js';

const logger = Logger.getInstance();

/** The streams a check reads and a removal deletes: StreamRepository. */
export interface RecordingStreams {
  list(): Promise<StreamRow[]>;
  findById(id: string): Promise<StreamRow | null>;
  deleteById(id: string, allowedFrom: readonly StreamStatus[]): Promise<boolean>;
}

/** A stream's rungs, which are the qualities of a ladder's recording: StreamRenditionRepository. */
export interface RecordingRenditions {
  listByStream(streamId: string): Promise<StreamRenditionRow[]>;
}

/** The export and the archive on the server, as the one rule and the removal read them. */
export interface RecordingJobs {
  /** The streams an export or an archive of is under way. */
  openJobStreams(): Promise<Set<string>>;
  /** The streams the server keeps a finished export file of. */
  exportFileStreams(): Promise<Set<string>>;
}

/** Where the recordings are read through, and whether the catalogue can be written: CatalogueBatchService. */
export interface RecordingsCatalogue {
  forRead(): Promise<{ target: CatalogueTarget | null } | { skipped: string }>;
  status(): Promise<{ refusal: { message: string } | null }>;
}

/** Takes streams off the catalogue in one write: PublishService. */
export interface LostRecordingsCatalogueWrite {
  takeOffCatalogue(
    actor: Actor,
    streamIds: readonly string[],
  ): Promise<{ index: number | null; kept: { streamId: string; reason: string }[] }>;
}

export interface RecordingCheckDeps {
  store: RecordingCheckStore;
  streams: RecordingStreams;
  renditions: RecordingRenditions;
  jobs: RecordingJobs;
  catalogue: RecordingsCatalogue;
  writer: LostRecordingsCatalogueWrite;
  reads: RecordingReads;
  audit: AuditLog;
}

export interface RecordingCheckOptions {
  /** `STREAM_RESTART_WINDOW_MINUTES`, which a stream's restart window is worked out with, as the stream list shows it. */
  restartWindowMinutes: number;
  now?: () => number;
  /** The wait between two rounds, {@link RECORDING_CHECK_ROUND_GAP_SECONDS}; a test shortens it. */
  roundGapMs?: number;
  /** Waits between two rounds, and rejects when `signal` aborts; a test passes one that does not wait. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  newId?: () => string;
}

/** A start or a removal refused, with the sentence the page shows: `409` with the message. */
export class RecordingsRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordingsRefusedError';
  }
}

/** Why a check stops early, in the sentence the page shows. */
class CheckStopped extends Error {}

export const CHECK_RUNNING = 'A check of the recordings is running already.';
export const NO_CHECK_YET = 'No check of the recordings has run yet. Run Check recordings first.';
export const CHECK_STILL_RUNNING = 'The check of the recordings is still running.';
export const CHECK_STOPPED = 'The last check stopped without a result. Run a new check.';
export const NONE_LOST = 'The last check lists no lost recording.';
export const CHECK_TOO_OLD = 'The last check ended more than six hours ago. Run a new check before removing anything.';
export const NOT_THE_LATEST_CHECK = 'This is not the latest check of the recordings. Reload the page and look again.';
export const NOT_THE_LIST =
  'The recordings to remove are not the lost recordings the check lists. Reload the page and confirm the list again.';
export const NODE_NOT_ANSWERING = 'The catalogue node does not answer, so the recordings cannot be read.';
export const ADMIN_RESTARTED = 'The admin restarted while the check ran. Start a new check.';
export const GONE_ALREADY = 'It was deleted meanwhile.';
export const READS_NOW = 'It could be read now, so it is not removed.';
export const CHANGED_MEANWHILE = 'It changed meanwhile, so it was not deleted.';
export const NO_RECORDING_NOW = 'It holds no finished recording now, so it is not removed.';

/** Why a removal stops after reading the recordings once more: the node fell out of health while it read them. */
export function nodeFailedDuringRemoval(problem: string): string {
  return `${problem} It was so after the recordings were read once more, so those reads do not count and nothing was removed. Try again once the node is healthy.`;
}

/** Why a stream the removal asked the rule about again is kept. */
export const KEPT_BY_RULE: Readonly<Record<RecordingSkipReason, string>> = {
  live: 'It is live now.',
  restart_window: 'It can still go live again on its key.',
  job: 'An export or an archive of it is under way.',
  test: 'It is a test stream.',
  unlisted: 'A removal kept it as a draft for its export file before, and it has not changed since.',
};

export function noCatalogueNode(why: string): string {
  return `There is no catalogue node to read the recordings through: ${why}`;
}

export function tooFewPeers(peers: number, floor: number): string {
  return `The catalogue node is connected to ${peers} peer${peers === 1 ? '' : 's'}, and reading the recordings needs ${floor} or more, or a recording that is on Swarm could not be told from one that is lost.`;
}

export function catalogueNotWritable(why: string): string {
  return `${why} Lost recordings can be removed once the catalogue can be written again: buy a new catalogue batch on the Stamps tab of the Funding page first.`;
}

/** The actor of what the check does by itself: its rounds and its end. */
const CHECK_ACTOR: Actor = { kind: 'system', reason: 'recording check' };

/** How long the catalogue node's health, read for the page, is kept before it is read again. */
const HEALTH_TTL_MS = 15_000;

interface NodeHealth {
  node: ReadNode | null;
  target: CatalogueTarget | null;
  problem: string | null;
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function checkedOf(row: RecordingCheckStreamRow): CheckedRecording {
  return {
    streamId: row.streamId,
    title: row.title,
    status: row.status,
    verdict: row.verdict === 'partly_lost' ? 'partly_lost' : 'lost',
    failedQualities: failedQualitiesOf(row.readings),
    hasExportFile: row.hasExportFile,
  };
}

/** The lost recordings a removal can still take: lost, and not taken by an earlier removal. */
function removable(rows: readonly RecordingCheckStreamRow[]): RecordingCheckStreamRow[] {
  return rows.filter((row) => row.verdict === 'lost' && row.removal === null);
}

function sameIds(asked: readonly string[], listed: readonly string[]): boolean {
  const wanted = new Set(asked.map((id) => id.toLowerCase()));
  return (
    wanted.size === asked.length && wanted.size === listed.length && listed.every((id) => wanted.has(id.toLowerCase()))
  );
}

/**
 * Checking the recordings and removing the lost ones. `docs/architecture/web2-admin.md`, "Lost recordings", is the
 * design.
 *
 * A check is started by a person, and one runs at a time for the whole admin. It reads every recording the one rule,
 * `recordingSkipReason`, lets it judge, through the catalogue node: the recording's own playlist, and each quality's
 * playlist and first segment. What failed is read again {@link RECORDING_CHECK_ROUND_GAP_SECONDS} later, twice, and
 * only a failure in every one of {@link RECORDING_CHECK_ROUNDS} rounds counts. Each round starts, and its failures
 * count, only while the node is connected to {@link RECORDING_CHECK_MIN_PEERS} peers or more; otherwise the check stops
 * with no result. Each stream is asked the rule again before it is judged. The rounds run in this process, so a restart
 * stops the check, and the next boot says so.
 *
 * The removal takes the lost recordings of the latest finished check, within {@link RECORDING_CHECK_VALID_SECONDS}.
 * Each is asked the rule again and read once more, and one that may not be judged now or that reads now is kept,
 * with why. The rest leave the catalogue in one write; one the server keeps an export file of stays as a draft, and
 * every other is deleted. Each is audited.
 */
export class RecordingCheckService {
  private readonly lock = new Mutex();
  private job: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private progress: { checkId: string; read: number } | null = null;
  private cachedHealth: { at: number; health: NodeHealth } | null = null;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly roundGapMs: number;

  constructor(
    private readonly deps: RecordingCheckDeps,
    private readonly options: RecordingCheckOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.wait = options.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }));
    this.roundGapMs = options.roundGapMs ?? RECORDING_CHECK_ROUND_GAP_SECONDS * 1000;
  }

  /** The latest check, and why a new one cannot start, or its lost recordings cannot be removed, now. */
  async status(): Promise<RecordingCheckResponse> {
    const latest = await this.deps.store.latest();
    const rows = latest ? await this.deps.store.streams(latest.id) : [];
    const health = await this.health();
    return {
      check: latest ? this.summaryOf(latest, rows) : null,
      startRefusal: this.startRefusalOf(latest, health),
      removalRefusal: await this.removalRefusalOf(latest, rows, health),
    };
  }

  /** Starts a check, or refuses with why: one is running, or the catalogue node cannot be read through. */
  async start(actor: OperatorActor): Promise<RecordingCheckResponse> {
    await this.lock.run(async () => {
      const latest = await this.deps.store.latest();
      const refusal = this.startRefusalOf(latest, await this.health(true));
      if (refusal) throw new RecordingsRefusedError(refusal);

      const now = new Date(this.now());
      const jobs = await this.deps.jobs.openJobStreams();
      const judged: { streamId: string; title: string; status: StreamStatus }[] = [];
      let unjudged = 0;
      for (const stream of await this.deps.streams.list()) {
        if (stream.manifest_index === null) continue;
        const input = recordingJudgeInputOf(stream, jobs, this.options.restartWindowMinutes);
        if (recordingSkipReason(input, now) !== null) {
          unjudged += 1;
          continue;
        }
        judged.push({ streamId: stream.id, title: stream.title, status: stream.status });
      }
      const check = await this.deps.store.create({
        id: this.newId(),
        startedBy: describeActor(actor),
        startedByUserId: actor.userId,
        unjudged,
        streams: judged,
      });
      if (!check) throw new RecordingsRefusedError(CHECK_RUNNING);

      logger.info(
        `[Recordings] ${describeActor(actor)} started a check of ${judged.length} recording${judged.length === 1 ? '' : 's'}, ${unjudged} left unjudged`,
      );
      await recordAudit(this.deps.audit, {
        actor,
        action: 'recording.check.start',
        details: { checkId: check.id, recordings: judged.length, unjudged },
      });
      this.launch(check.id);
    });
    return this.status();
  }

  /** Removes the lost recordings of the latest check, as `LostRecordingsRemovalResponse` says, or refuses with why. */
  async removeLost(
    actor: OperatorActor,
    request: LostRecordingsRemovalRequest,
  ): Promise<LostRecordingsRemovalResponse> {
    return this.lock.run(async () => {
      const latest = await this.deps.store.latest();
      if (!latest || latest.id !== request.checkId) throw new RecordingsRefusedError(NOT_THE_LATEST_CHECK);
      const rows = await this.deps.store.streams(latest.id);
      const health = await this.health(true);
      const refusal = await this.removalRefusalOf(latest, rows, health);
      if (refusal) throw new RecordingsRefusedError(refusal);
      const lost = removable(rows);
      if (
        !sameIds(
          request.streamIds,
          lost.map((row) => row.streamId),
        )
      ) {
        throw new RecordingsRefusedError(NOT_THE_LIST);
      }

      const node = health.node!;
      const now = new Date(this.now());
      const jobs = await this.deps.jobs.openJobStreams();
      const files = await this.deps.jobs.exportFileStreams();
      const kept: LostRecordingsRemovalResponse['kept'] = [];
      const keep = async (row: { streamId: string; title: string }, reason: string) => {
        kept.push({ streamId: row.streamId, title: row.title, reason });
        await this.deps.store.recordRemoval(latest.id, row.streamId, 'kept', reason);
      };

      // Each one asked the rule again and read once more: one that may not be judged now, holds no recording now, or
      // reads now, is kept. Nothing is written until the node is found healthy again after the reads.
      const going: StreamRow[] = [];
      const keeping: { row: RecordingCheckStreamRow; reason: string; readsNow: boolean }[] = [];
      for (const row of lost) {
        const stream = await this.deps.streams.findById(row.streamId);
        if (!stream) {
          keeping.push({ row, reason: GONE_ALREADY, readsNow: false });
          continue;
        }
        const skip = recordingSkipReason(recordingJudgeInputOf(stream, jobs, this.options.restartWindowMinutes), now);
        if (skip !== null) {
          keeping.push({ row, reason: KEPT_BY_RULE[skip], readsNow: false });
          continue;
        }
        const parts = recordingPartsOf(stream, await this.deps.renditions.listByStream(stream.id));
        if (!parts) {
          keeping.push({ row, reason: NO_RECORDING_NOW, readsNow: false });
          continue;
        }
        const readings = await readRecordingRound(this.deps.reads, node, parts, { master: [], qualities: [] });
        if (!lostInOneRead(readings)) {
          keeping.push({ row, reason: READS_NOW, readsNow: true });
          continue;
        }
        going.push(stream);
      }

      // The reads once more count only while the node stayed healthy through them, as a check's round does.
      const after = await this.health(true);
      if (after.problem !== null) throw new RecordingsRefusedError(nodeFailedDuringRemoval(after.problem));
      for (const { row, reason, readsNow } of keeping) {
        await keep(row, reason);
        if (readsNow) await this.deps.store.clearVerdict(row.streamId);
      }

      // The rest leave the catalogue in one write.
      const off =
        going.length > 0
          ? await this.deps.writer.takeOffCatalogue(
              actor,
              going.map((stream) => stream.id),
            )
          : { index: null, kept: [] };
      const refusedThere = new Map(off.kept.map((one) => [one.streamId, one.reason]));
      const removed: RemovedRecording[] = [];
      const unlisted: RemovedRecording[] = [];
      for (const stream of going) {
        const named = { streamId: stream.id, title: stream.title };
        const reason = refusedThere.get(stream.id);
        if (reason) {
          await keep(named, reason);
          continue;
        }
        if (files.has(stream.id)) {
          unlisted.push(named);
          await this.deps.store.recordRemoval(latest.id, stream.id, 'unlisted', null);
          await recordAudit(this.deps.audit, {
            actor,
            action: 'recording.lost.unlist',
            streamId: stream.id,
            topic: stream.topic,
            statusBefore: stream.status,
            statusAfter: 'draft',
            details: { checkId: latest.id, feedIndex: off.index, title: stream.title },
          });
          continue;
        }
        if (!(await this.deps.streams.deleteById(stream.id, ['draft']))) {
          await keep(named, CHANGED_MEANWHILE);
          continue;
        }
        removed.push(named);
        await this.deps.store.recordRemoval(latest.id, stream.id, 'removed', null);
        await recordAudit(this.deps.audit, {
          actor,
          action: 'recording.lost.delete',
          streamId: stream.id,
          topic: stream.topic,
          statusBefore: stream.status,
          statusAfter: null,
          details: { checkId: latest.id, feedIndex: off.index, title: stream.title },
        });
        logger.info(`[Recordings] ${describeActor(actor)} deleted ${describeStream(stream)}, whose recording is lost`);
      }

      logger.info(
        `[Recordings] ${describeActor(actor)} removed the lost recordings of check ${latest.id}: ${removed.length} deleted, ${unlisted.length} kept as drafts for their export file, ${kept.length} kept${
          off.index === null ? '' : `, the catalogue written at feed index ${off.index}`
        }`,
      );
      return { removed, unlisted, kept, feedIndex: off.index };
    });
  }

  /** At boot: a check left running by the process that stopped is stopped, since its rounds ran in that process. */
  async boot(): Promise<void> {
    const stopped = await this.deps.store.stopRunning(ADMIN_RESTARTED);
    for (const check of stopped) {
      logger.warn(
        `[Recordings] the check ${check.id} was running when the admin stopped; it is stopped with no result`,
      );
      await recordAudit(this.deps.audit, {
        actor: { kind: 'system', reason: 'boot' },
        action: 'recording.check.finish',
        details: { checkId: check.id, state: 'stopped', message: ADMIN_RESTARTED },
      });
    }
  }

  /** Stops the rounds of a running check; it stays running in the database, and the next boot stops it. */
  async shutdown(): Promise<void> {
    this.abort?.abort();
    await this.job;
  }

  /** Resolves once the check running now, if any, has ended or stopped. For the tests. */
  async settled(): Promise<void> {
    await this.job;
  }

  private launch(checkId: string): void {
    const abort = new AbortController();
    this.abort = abort;
    const job: Promise<void> = this.run(checkId, abort.signal).finally(() => {
      if (this.job === job) {
        this.job = null;
        this.abort = null;
        this.progress = null;
      }
    });
    this.job = job;
  }

  private async run(checkId: string, signal: AbortSignal): Promise<void> {
    try {
      for (let round = 1; round <= RECORDING_CHECK_ROUNDS; round += 1) {
        const node = await this.healthyNode();
        if (!(await this.deps.store.recordRound(checkId, round, null))) return;
        const pending = await this.readRound(checkId, node, signal);
        // The node still healthy when the round ends, so the round's failures count.
        await this.healthyNode();
        if (pending === 0 || round === RECORDING_CHECK_ROUNDS) {
          await this.finish(checkId);
          return;
        }
        const next = new Date(this.now() + this.roundGapMs);
        if (!(await this.deps.store.recordRound(checkId, round, next))) return;
        logger.info(
          `[Recordings] round ${round} of the check left ${pending} recording${pending === 1 ? '' : 's'} to read again`,
        );
        await this.wait(this.roundGapMs, signal);
      }
    } catch (error) {
      if (signal.aborted) {
        logger.info('[Recordings] the check stopped for the shutdown; the next boot ends it');
        return;
      }
      const message =
        error instanceof CheckStopped ? error.message : `The check stopped with no result: ${getErrorMessage(error)}`;
      logger.warn(`[Recordings] ${message}`);
      const stopped = await this.deps.store.stop(checkId, message).catch((failure: unknown) => {
        logger.error(`[Recordings] could not record why the check stopped: ${getErrorMessage(failure)}`);
        return null;
      });
      if (stopped) {
        await recordAudit(this.deps.audit, {
          actor: CHECK_ACTOR,
          action: 'recording.check.finish',
          details: { checkId, state: 'stopped', message },
        });
      }
    }
  }

  /** Reads every recording of the check that is not read yet once, and answers how many still are not. */
  private async readRound(checkId: string, node: ReadNode, signal: AbortSignal): Promise<number> {
    const rows = await this.deps.store.streams(checkId);
    const progress = { checkId, read: 0 };
    this.progress = progress;
    let pending = 0;
    for (const row of rows) {
      if (signal.aborted) throw new Error('the admin is shutting down');
      if (stillUnread(row.readings)) {
        const stream = await this.deps.streams.findById(row.streamId);
        const parts = stream ? recordingPartsOf(stream, await this.deps.renditions.listByStream(stream.id)) : null;
        // A stream gone, live again or holding no recording any more is read no further; the end leaves it unjudged.
        if (parts) {
          const readings = await readRecordingRound(this.deps.reads, node, parts, row.readings);
          await this.deps.store.recordReadings(checkId, row.streamId, readings);
          if (stillUnread(readings)) pending += 1;
        }
      }
      progress.read += 1;
    }
    return pending;
  }

  /** The verdicts, each stream asked the one rule again first, and the end of the check. */
  private async finish(checkId: string): Promise<void> {
    const check = await this.deps.store.latest();
    if (!check || check.id !== checkId) return;
    const rows = await this.deps.store.streams(checkId);
    const now = new Date(this.now());
    const jobs = await this.deps.jobs.openJobStreams();
    const files = await this.deps.jobs.exportFileStreams();
    let unjudged = check.unjudged;
    const verdicts: StreamVerdict[] = [];
    for (const row of rows) {
      const stream = await this.deps.streams.findById(row.streamId);
      const judged =
        stream !== null &&
        stream.manifest_index !== null &&
        recordingSkipReason(recordingJudgeInputOf(stream, jobs, this.options.restartWindowMinutes), now) === null;
      if (!judged) unjudged += 1;
      verdicts.push({
        streamId: row.streamId,
        verdict: judged ? recordingVerdict(row.readings) : null,
        hasExportFile: files.has(row.streamId),
      });
    }
    if (!(await this.deps.store.finish(checkId, verdicts, unjudged))) return;
    const lost = verdicts.filter((one) => one.verdict === 'lost').length;
    const partlyLost = verdicts.filter((one) => one.verdict === 'partly_lost').length;
    logger.info(
      `[Recordings] the check of ${rows.length} recording${rows.length === 1 ? '' : 's'} ended: ${lost} lost, ${partlyLost} partly lost, ${unjudged} unjudged`,
    );
    await recordAudit(this.deps.audit, {
      actor: CHECK_ACTOR,
      action: 'recording.check.finish',
      details: { checkId, state: 'done', lost, partlyLost, unjudged },
    });
  }

  /** The node to read through, healthy now; otherwise the check stops with why. */
  private async healthyNode(): Promise<ReadNode> {
    const health = await this.health(true);
    if (health.problem !== null || !health.node) {
      throw new CheckStopped(`${health.problem ?? NODE_NOT_ANSWERING} The check stopped with no result.`);
    }
    return health.node;
  }

  /** The catalogue node and whether it is healthy: designated, answering, and with enough peers. */
  private async health(fresh = false): Promise<NodeHealth> {
    const now = this.now();
    if (!fresh && this.cachedHealth && now - this.cachedHealth.at < HEALTH_TTL_MS) return this.cachedHealth.health;
    const health = await this.readHealth();
    this.cachedHealth = { at: now, health };
    return health;
  }

  private async readHealth(): Promise<NodeHealth> {
    const read = await this.deps.catalogue.forRead();
    if ('skipped' in read) return { node: null, target: null, problem: noCatalogueNode(read.skipped) };
    if (!read.target) {
      return {
        node: null,
        target: null,
        problem: noCatalogueNode('the manager has not designated a catalogue node yet.'),
      };
    }
    const node = { beeApiUrl: read.target.beeApiUrl };
    try {
      const peers = await this.deps.reads.peers(node);
      if (peers < RECORDING_CHECK_MIN_PEERS) {
        return { node, target: read.target, problem: tooFewPeers(peers, RECORDING_CHECK_MIN_PEERS) };
      }
      return { node, target: read.target, problem: null };
    } catch (error) {
      logger.warn(
        `[Recordings] the catalogue node did not say how many peers it has: ${withoutCatalogueNode(getErrorMessage(error), read.target)}`,
      );
      return { node, target: read.target, problem: NODE_NOT_ANSWERING };
    }
  }

  private startRefusalOf(latest: RecordingCheckRow | null, health: NodeHealth): string | null {
    if (latest?.state === 'running') return CHECK_RUNNING;
    return health.problem;
  }

  private async removalRefusalOf(
    latest: RecordingCheckRow | null,
    rows: readonly RecordingCheckStreamRow[],
    health: NodeHealth,
  ): Promise<string | null> {
    if (!latest) return NO_CHECK_YET;
    if (latest.state === 'running') return CHECK_STILL_RUNNING;
    if (latest.state === 'stopped') return CHECK_STOPPED;
    if (removable(rows).length === 0) return NONE_LOST;
    const ended = latest.finishedAt?.getTime() ?? 0;
    if (this.now() - ended > RECORDING_CHECK_VALID_SECONDS * 1000) return CHECK_TOO_OLD;
    const catalogue = await this.deps.catalogue.status();
    if (catalogue.refusal) return catalogueNotWritable(catalogue.refusal.message);
    return health.problem;
  }

  private summaryOf(row: RecordingCheckRow, rows: readonly RecordingCheckStreamRow[]): RecordingCheck {
    const done = row.state === 'done';
    const running = row.state === 'running';
    return {
      id: row.id,
      state: row.state,
      stopMessage: row.stopMessage,
      round: row.round,
      nextRoundAt: iso(row.nextRoundAt),
      total: rows.length,
      readThisRound: running ? (this.progress?.checkId === row.id ? this.progress.read : 0) : rows.length,
      unjudged: row.unjudged,
      lost: done ? removable(rows).map(checkedOf) : [],
      partlyLost: done ? rows.filter((one) => one.verdict === 'partly_lost').map(checkedOf) : [],
      startedBy: row.startedBy,
      startedAt: row.startedAt.toISOString(),
      finishedAt: iso(row.finishedAt),
    };
  }
}
