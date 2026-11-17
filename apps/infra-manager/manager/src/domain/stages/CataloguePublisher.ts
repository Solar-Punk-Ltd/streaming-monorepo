import {
  type ArchiveBatchDesignation,
  type CataloguePushOutcome,
  type CataloguePushState,
  type CatalogueReading,
  getErrorMessage,
  isArchiveBatchSpent,
  isLoopbackIngestHost,
  shortHex,
  type StampHealth,
} from '@streaming-infra-manager/common';
import {
  CATALOGUE_ARCHIVE_BATCHES_MAX,
  type CatalogueArchiveBatch,
  type CatalogueStampPrevious,
  type CatalogueStampRecord,
  STAGE_RECORD_SCHEMA_VERSION,
} from '@streaming-monorepo/contracts';

import type { Profile } from '../../types/index.js';
import type { StoredAdminLinkSecret } from '../adminLink/ManagerAdminLinkRepository.js';
import type { ManagerEvent } from '../EventBus.js';
import { Logger } from '../Logger.js';
import { beePublisherUrlFor } from '../StampService.js';

import { archiveBatchWritable, type ArchiveBatchStatus, isArchiveDepth } from './ArchiveBatchService.js';
import { type CatalogueDesignationRow, isDesignated, isMoving } from './CatalogueDesignationRepository.js';
import type { CatalogueStatus } from './CatalogueDesignationService.js';
import { type CatalogueSender, sendCatalogueRequest } from './catalogueRequest.js';
import { STAGE_PUSH_INTERVAL_MS, type StageClock, SYSTEM_CLOCK } from './StagePublisher.js';

const logger = Logger.getInstance();

/** How often the pinned batch is read, so a change in its readings is pushed without waiting for the 30 seconds. */
export const CATALOGUE_CHECK_MS = 10_000;

/**
 * How far the batch's life may drift from the clock between two readings before it counts as a change: a top-up or a
 * dilution moves it by hours or days, and Bee's own estimate wanders by seconds.
 */
export const CATALOGUE_TTL_DRIFT_SECONDS = 300;

/**
 * The catalogue node's Bee API as the web2 admin dials it. The admin is another process or container, as an uploader
 * is, so the record carries the address a pool string carries (`beePublisherUrlFor`): the published host for a node on
 * this host, and a declared remote host's own address otherwise.
 */
export function publishedBeeApiUrl(publisherHost: () => Promise<string>): (profile: Profile) => Promise<string> {
  return async (profile) => beePublisherUrlFor(profile, await publisherHost());
}

export interface CataloguePublisherDeps {
  designation: { read(): Promise<CatalogueDesignationRow> };
  profiles: { findByName(name: string): Promise<Profile | null> };
  /**
   * The archive batches, `ArchiveBatchStore.list`, read on the same cadence and carried as the record's
   * `archiveBatches`, and `recordDepth`, which keeps the depth a reading reported. Without it the record leaves the
   * field out, as a manager older than the field does.
   */
  archiveBatches?: {
    list(): Promise<ArchiveBatchDesignation[]>;
    recordDepth(batchId: string, depth: number): Promise<void>;
  };
  /** The pinned batch as the node reports it, `StampService.batchReadingFor`. Never throws. */
  reading(profile: Profile, batchId: string): Promise<{ health: StampHealth; depth: number | null }>;
  /**
   * The node's Bee API as the web2 admin dials it, from another process or container: the address a pool string
   * carries, {@link publishedBeeApiUrl}.
   */
  beeApiUrl(profile: Profile): Promise<string>;
  link: { storedLink(): Promise<StoredAdminLinkSecret> };
  events: { subscribe(listener: (event: ManagerEvent) => void): () => void };
  managerId: string;
  send?: CatalogueSender;
  clock?: StageClock;
  intervalMs?: number;
  checkMs?: number;
}

/** Whether a push has to go now, or only when the readings moved. */
type Urge = 'always' | 'if-changed';

/** What the last stored record said, to tell whether the next one says anything new. */
interface Sent {
  key: string;
  ttlSeconds: number | null;
  /** The time to live of the batch moved from, when the record carried one. */
  previousTtlSeconds: number | null;
  /** The time to live of each archive batch the record carried, by batch id. */
  archiveTtlSeconds: ReadonlyMap<string, number | null>;
  at: number;
}

/** Whether an address names the dialling host itself: `localhost`, `127.0.0.0/8`, `0.0.0.0` or `[::1]`. */
function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackIngestHost(new URL(url).host);
  } catch {
    return true;
  }
}

/**
 * Whether a batch's life moved by more than the clock's own wear since it was sent: a top-up or a dilution, and not
 * Bee's estimate wandering by seconds.
 */
function lifeMoved(sent: number | null, now: number | null, elapsedSeconds: number): boolean {
  if (sent === null || now === null) return sent !== now;
  return Math.abs(now - (sent - elapsedSeconds)) > CATALOGUE_TTL_DRIFT_SECONDS;
}

const ANSWERED_STORE: readonly CataloguePushOutcome[] = ['stored', 'older-ignored'];
const ANSWERED_CLEAR: readonly CataloguePushOutcome[] = ['cleared', 'not-cleared'];

/**
 * Pushes the brand's catalogue stamp record into the web2 admin the manager's link names, with the link's stored
 * token, as the stage publisher pushes stage records: when the designation changes, whenever the pinned batch's
 * readings change, which it reads every ten seconds, and every 30 seconds. A designation taken out is cleared there
 * with `DELETE`, carrying the moment it was taken out. One call at a time: a trigger that comes while one is in flight
 * makes one more after it, so a clear never overtakes the push before it.
 *
 * While a move is pending, the batch the catalogue moved from is read on the same cadence, for the card and for the
 * admin: the record stays the pinned batch's, and carries the one moved from as `previous`, because the admin keeps
 * writing with that batch until its own move runs and would otherwise hold only readings that age. A change in its
 * readings is pushed as one in the pinned batch's is. A reading the node did not answer, or one with no depth or with
 * an address that reaches the dialling host alone, is left out, so the admin keeps the last one it had.
 *
 * Every archive batch is read on the same cadence, each on the node of its own deployment, and the record carries
 * them as `archiveBatches`, up to its maximum, the expired and gone ones last, a batch whose node does not answer with
 * the depth the manager keeps for it, each `writable` only while its deployment is the designated catalogue node and
 * its node calls it usable. A change in their readings, or in the list, is pushed as one in the pinned batch's is.
 *
 * The last outcome and the last readings are kept in memory for the Manager settings card. The log says the outcome
 * when it changes, and never what the admin answered, its address or a token.
 */
export class CataloguePublisher {
  private readonly send: CatalogueSender;
  private readonly clock: StageClock;
  private readonly intervalMs: number;
  private readonly checkMs: number;
  private inFlight: Promise<void> | null = null;
  private again: Urge | null = null;
  private last: CataloguePushState | null = null;
  private reading: CatalogueReading | null = null;
  /** The last reading of the batch the catalogue is moving from, while a move is pending. */
  private previousReading: CatalogueReading | null = null;
  /** The last reading of each archive batch, by batch id. */
  private archiveReadings: ReadonlyMap<string, CatalogueReading> = new Map();
  /** How many archive batches there were when the record last carried only the first ones, logged once per count. */
  private archiveTruncationLogged: number | null = null;
  private sent: Sent | null = null;
  /** The clear moment the admin answered, so a clear is sent until it is answered and not after. */
  private clearAnswered: string | null = null;
  /** The designated deployment as last read, whose change events push at once. */
  private designatedName: string | null = null;
  private lastDepth: { batchId: string; depth: number } | null = null;
  private loggedProblem: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private timer: unknown = null;
  private stopped = false;

  constructor(private readonly deps: CataloguePublisherDeps) {
    this.send = deps.send ?? sendCatalogueRequest;
    this.clock = deps.clock ?? SYSTEM_CLOCK;
    this.intervalMs = deps.intervalMs ?? STAGE_PUSH_INTERVAL_MS;
    this.checkMs = deps.checkMs ?? CATALOGUE_CHECK_MS;
  }

  start(): void {
    if (this.unsubscribe || this.stopped) return;
    this.unsubscribe = this.deps.events.subscribe((event) => {
      if (event.type === 'profile.changed' && event.profile.name === this.designatedName) void this.pushNow();
    });
    this.timer = this.clock.setInterval(() => void this.run('if-changed'), this.checkMs);
    // A restarted manager says what it holds at once, and sends again a clear it may not have had answered.
    void this.pushNow();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) this.clock.clearInterval(this.timer);
    this.timer = null;
    this.again = null;
  }

  /** The last readings of the pinned batch and of the one moved from, and the last call, for the Manager settings card. */
  status(): CatalogueStatus {
    return { reading: this.reading, previousReading: this.previousReading, lastPush: this.last };
  }

  /** The last readings of the archive batches and the last call, for the archive batches on the settings page. */
  archiveStatus(): ArchiveBatchStatus {
    return { readings: this.archiveReadings, lastPush: this.last };
  }

  /** Pushes or clears now, after a call in flight: what the designation service calls once it saved a change. */
  pushNow(): Promise<void> {
    return this.run('always');
  }

  private run(urge: Urge): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) {
      if (urge === 'always') this.again = 'always';
      else this.again ??= 'if-changed';
      // Settles once the call after this one has, which the finally below starts before the one in flight settles.
      return this.inFlight.then(() => this.inFlight ?? undefined);
    }
    const run = this.once(urge)
      .catch((err: unknown) => logger.warn(`[Catalogue] the push failed (${getErrorMessage(err)})`))
      .finally(() => {
        this.inFlight = null;
        const again = this.again;
        this.again = null;
        if (again && !this.stopped) void this.run(again);
      });
    this.inFlight = run;
    return run;
  }

  private async once(urge: Urge): Promise<void> {
    // Taken as the row is read, before the node is asked: the moment the record says it was observed.
    const readAt = this.clock.now();
    const row = await this.deps.designation.read();
    // Every batch is read at once, so the push waits for the slowest of the nodes, whose reads are bounded.
    const previous = this.readPrevious(row, readAt);
    const archive = this.readArchive(row, readAt);
    // Handled from the moment each read starts: the push reaches them only after the link, the node and its reading,
    // and a rejection left alone that long would stop the manager. The push still awaits each and reports a failure.
    const settled = Promise.all([previous.catch(() => undefined), archive.catch(() => undefined)]);
    try {
      await this.pushFor(row, urge, readAt, previous, archive);
    } finally {
      await settled;
    }
  }

  /**
   * Reads every archive batch on its own node, for the settings page and for the record, whether or not a catalogue
   * node is designated, and answers what the record carries of them, up to its maximum: the ones not spent first, in
   * the order they were designated, then the expired and gone ones (`isArchiveBatchSpent`), so a spent batch gives
   * its place to one with life left. A batch whose node did not answer, or whose deployment is gone, is carried as
   * `unknown`, which is not spent, with the depth the manager keeps for it, which each reading that reports another
   * one refreshes. Rejects only when the list itself could not be read, so no push says the admin has no archive
   * batches when it has.
   */
  private async readArchive(row: CatalogueDesignationRow, readAt: number): Promise<CatalogueArchiveBatch[] | null> {
    const archive = this.deps.archiveBatches;
    if (!archive) return null;
    const listed = await archive.list();
    this.logArchiveTruncation(listed.length);
    const catalogueProfileName = isDesignated(row) ? row.profileName : null;
    const read = await Promise.all(
      listed.map(async (batch) => ({ batch, reading: await this.readArchiveBatch(batch, readAt) })),
    );
    this.archiveReadings = new Map(read.map(({ batch, reading }) => [batch.batchId, reading]));
    const carried = [
      ...read.filter(({ reading }) => !isArchiveBatchSpent(reading.state)),
      ...read.filter(({ reading }) => isArchiveBatchSpent(reading.state)),
    ].slice(0, CATALOGUE_ARCHIVE_BATCHES_MAX);

    return carried.map(({ batch, reading }) => ({
      batchId: batch.batchId,
      label: batch.label,
      // Adopted only as immutable, and bought only as immutable, and a batch's kind never changes.
      immutable: reading.immutable ?? true,
      depth: isArchiveDepth(reading.depth) ? reading.depth : batch.depth,
      state: reading.state,
      ttlSeconds: reading.ttlSeconds,
      fillRatio: reading.fillRatio,
      writable: archiveBatchWritable(batch.profileName, catalogueProfileName, reading.state),
      designatedAt: batch.designatedAt,
    }));
  }

  /** Says once per count that the record carries only some of the archive batches. */
  private logArchiveTruncation(count: number): void {
    if (count <= CATALOGUE_ARCHIVE_BATCHES_MAX) {
      this.archiveTruncationLogged = null;
      return;
    }
    if (this.archiveTruncationLogged === count) return;
    logger.warn(
      `[Catalogue] there are ${count} archive batches, and the catalogue stamp record carries ${CATALOGUE_ARCHIVE_BATCHES_MAX} of them, those not expired or gone first`,
    );
    this.archiveTruncationLogged = count;
  }

  /**
   * One archive batch as its own node reports it, `unknown` when the node or its deployment did not answer, with the
   * depth the manager keeps for it then. A depth the node reports that differs from the one kept is kept from now on.
   */
  private async readArchiveBatch(batch: ArchiveBatchDesignation, readAt: number): Promise<CatalogueReading> {
    let health: StampHealth | null = null;
    let depth: number | null = null;
    try {
      const profile = await this.deps.profiles.findByName(batch.profileName);
      if (profile) ({ health, depth } = await this.deps.reading(profile, batch.batchId));
    } catch (err) {
      logger.warn(`[Catalogue] reading archive batch ${shortHex(batch.batchId)} failed (${getErrorMessage(err)})`);
    }
    const reported = isArchiveDepth(depth) ? depth : null;
    if (reported !== null && reported !== batch.depth) {
      await this.deps.archiveBatches?.recordDepth(batch.batchId, reported).catch((err: unknown) => {
        logger.warn(
          `[Catalogue] keeping depth ${reported} of archive batch ${shortHex(batch.batchId)} failed (${getErrorMessage(err)})`,
        );
      });
    }
    return {
      batchId: batch.batchId,
      state: health?.state ?? 'unknown',
      ttlSeconds: health?.ttl ?? null,
      fillRatio: health?.fillRatio ?? null,
      immutable: health?.immutable ?? null,
      depth: reported ?? batch.depth,
      readAt: new Date(readAt).toISOString(),
    };
  }

  /**
   * Reads the batch the catalogue is moving from, while a move is pending, for the card, and answers what the record
   * carries of it as `previous`: null when no move is pending, and when the reading is not one to send. Never throws.
   */
  private async readPrevious(row: CatalogueDesignationRow, readAt: number): Promise<CatalogueStampPrevious | null> {
    if (!isMoving(row)) {
      this.previousReading = null;
      return null;
    }
    try {
      const profile = await this.deps.profiles.findByName(row.movingFromProfileName);
      if (!profile) {
        this.previousReading = null;
        return null;
      }
      const { health, depth } = await this.deps.reading(profile, row.movingFromBatchId);
      const knownDepth = depth ?? row.movingFromBatchDepth;
      this.previousReading = {
        batchId: row.movingFromBatchId,
        state: health.state,
        ttlSeconds: health.ttl,
        fillRatio: health.fillRatio,
        immutable: health.immutable,
        depth: knownDepth,
        readAt: new Date(readAt).toISOString(),
      };
      // A node that did not answer says nothing new about the batch, and the admin keeps the last reading it had.
      if (health.state === 'unknown' || knownDepth === null) return null;
      const beeApiUrl = await this.deps.beeApiUrl(profile);
      if (isLoopbackUrl(beeApiUrl)) return null;
      return {
        nodeName: profile.name,
        beeApiUrl,
        batchId: row.movingFromBatchId,
        // It was designated before the move, which refused a batch whose kind the node did not report.
        immutable: health.immutable ?? true,
        depth: knownDepth,
        state: health.state,
        ttlSeconds: health.ttl,
        fillRatio: health.fillRatio,
      };
    } catch (err) {
      logger.warn(`[Catalogue] reading the batch the catalogue is moving from failed (${getErrorMessage(err)})`);
      return null;
    }
  }

  private async pushFor(
    row: CatalogueDesignationRow,
    urge: Urge,
    readAt: number,
    previousRead: Promise<CatalogueStampPrevious | null>,
    archiveRead: Promise<CatalogueArchiveBatch[] | null>,
  ): Promise<void> {
    if (!isDesignated(row)) {
      this.designatedName = null;
      this.reading = null;
      this.sent = null;
      if (!row.clearedAt) return;
      const clearedAt = row.clearedAt.toISOString();
      if (this.clearAnswered === clearedAt) return;
      const link = await this.deps.link.storedLink();
      if (!link.url || !link.token) return this.record('clear', 'skipped-no-link');
      const outcome = await this.send({ kind: 'clear', baseUrl: link.url, token: link.token, observedAt: clearedAt });
      if (ANSWERED_CLEAR.includes(outcome)) this.clearAnswered = clearedAt;
      return this.record('clear', outcome);
    }
    this.designatedName = row.profileName;
    this.clearAnswered = null;

    const profile = await this.deps.profiles.findByName(row.profileName);
    if (!profile) {
      this.reading = null;
      return this.record('store', 'skipped-no-node');
    }
    const { health, depth } = await this.deps.reading(profile, row.batchId);
    if (depth !== null) this.lastDepth = { batchId: row.batchId, depth };
    const knownDepth = depth ?? (this.lastDepth?.batchId === row.batchId ? this.lastDepth.depth : row.batchDepth);
    this.reading = {
      batchId: row.batchId,
      state: health.state,
      ttlSeconds: health.ttl,
      fillRatio: health.fillRatio,
      immutable: health.immutable,
      depth: knownDepth,
      readAt: new Date(readAt).toISOString(),
    };
    if (knownDepth === null) {
      this.logProblem('the pinned batch has no depth the node reported');
      return this.record('store', 'skipped-no-record');
    }

    const link = await this.deps.link.storedLink();
    if (!link.url || !link.token) return this.record('store', 'skipped-no-link');

    // The admin dials this address from another container, so one that reaches only the dialling host is no address.
    const beeApiUrl = await this.deps.beeApiUrl(profile);
    if (isLoopbackUrl(beeApiUrl)) {
      this.logProblem(
        `${profile.name}'s Bee API is ${beeApiUrl}, which reaches the dialling host alone; the web2 admin needs an address it can dial`,
      );
      return this.record('store', 'skipped-loopback-address');
    }
    this.loggedProblem = null;

    const previous = await previousRead;
    const archiveBatches = await archiveRead;
    const record: CatalogueStampRecord = {
      schemaVersion: STAGE_RECORD_SCHEMA_VERSION,
      managerId: this.deps.managerId,
      nodeName: profile.name,
      beeApiUrl,
      batchId: row.batchId,
      // The designation refused a batch whose kind the node did not report, and a batch's kind never changes.
      immutable: health.immutable ?? true,
      depth: knownDepth,
      state: health.state,
      ttlSeconds: health.ttl,
      fillRatio: health.fillRatio,
      designatedAt: row.designatedAt.toISOString(),
      observedAt: new Date(readAt).toISOString(),
      previous,
      ...(archiveBatches ? { archiveBatches } : {}),
    };
    const key = JSON.stringify([
      link.url,
      record.nodeName,
      record.beeApiUrl,
      record.batchId,
      record.immutable,
      record.depth,
      record.state,
      record.fillRatio,
      record.designatedAt,
      previous && [
        previous.nodeName,
        previous.beeApiUrl,
        previous.batchId,
        previous.immutable,
        previous.depth,
        previous.state,
        previous.fillRatio,
      ],
      (archiveBatches ?? []).map((batch) => [
        batch.batchId,
        batch.label,
        batch.immutable,
        batch.depth,
        batch.state,
        batch.fillRatio,
        batch.writable,
        batch.designatedAt,
      ]),
    ]);
    const previousTtlSeconds = previous?.ttlSeconds ?? null;
    const archiveTtlSeconds = new Map((archiveBatches ?? []).map((batch) => [batch.batchId, batch.ttlSeconds]));
    if (urge === 'if-changed' && !this.due(key, record.ttlSeconds, previousTtlSeconds, archiveTtlSeconds, readAt)) {
      return;
    }

    const outcome = await this.send({ kind: 'store', baseUrl: link.url, token: link.token, record });
    this.sent = ANSWERED_STORE.includes(outcome)
      ? { key, ttlSeconds: record.ttlSeconds, previousTtlSeconds, archiveTtlSeconds, at: readAt }
      : null;
    return this.record('store', outcome);
  }

  /**
   * Whether a push is owed: 30 seconds since the last one the admin answered, or a reading that moved, of the pinned
   * batch, of the one moved from or of an archive batch.
   */
  private due(
    key: string,
    ttlSeconds: number | null,
    previousTtlSeconds: number | null,
    archiveTtlSeconds: ReadonlyMap<string, number | null>,
    at: number,
  ): boolean {
    const sent = this.sent;
    if (!sent || sent.key !== key || at - sent.at >= this.intervalMs) return true;
    const elapsedSeconds = (at - sent.at) / 1000;
    if (lifeMoved(sent.ttlSeconds, ttlSeconds, elapsedSeconds)) return true;
    if (lifeMoved(sent.previousTtlSeconds, previousTtlSeconds, elapsedSeconds)) return true;
    // The key holds the same batches in the same order, so each one has a time to live that was sent.
    for (const [batchId, ttl] of archiveTtlSeconds) {
      if (lifeMoved(sent.archiveTtlSeconds.get(batchId) ?? null, ttl, elapsedSeconds)) return true;
    }
    return false;
  }

  private logProblem(problem: string): void {
    if (this.loggedProblem === problem) return;
    logger.warn(`[Catalogue] no catalogue stamp record: ${problem}`);
    this.loggedProblem = problem;
  }

  private record(kind: CataloguePushState['kind'], outcome: CataloguePushOutcome): void {
    const before = this.last;
    this.last = { kind, outcome, at: new Date(this.clock.now()).toISOString() };
    if (before?.kind === kind && before.outcome === outcome) return;
    const line = `[Catalogue] ${kind === 'store' ? 'pushing the catalogue stamp record' : 'clearing the catalogue stamp'} came to ${outcome}`;
    if ([...ANSWERED_STORE, ...ANSWERED_CLEAR].includes(outcome)) logger.info(line);
    else logger.warn(line);
  }
}
