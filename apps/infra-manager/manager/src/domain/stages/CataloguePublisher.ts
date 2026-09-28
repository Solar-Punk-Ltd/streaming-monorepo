import {
  type CataloguePushOutcome,
  type CataloguePushState,
  type CatalogueReading,
  getErrorMessage,
  isLoopbackIngestHost,
  type StampHealth,
} from '@streaming-infra-manager/common';
import {
  type CatalogueStampPrevious,
  type CatalogueStampRecord,
  STAGE_RECORD_SCHEMA_VERSION,
} from '@streaming-monorepo/contracts';

import type { Profile } from '../../types/index.js';
import type { StoredAdminLinkSecret } from '../adminLink/ManagerAdminLinkRepository.js';
import type { ManagerEvent } from '../EventBus.js';
import { Logger } from '../Logger.js';

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

export interface CataloguePublisherDeps {
  designation: { read(): Promise<CatalogueDesignationRow> };
  profiles: { findByName(name: string): Promise<Profile | null> };
  /** The pinned batch as the node reports it, `StampService.batchReadingFor`. Never throws. */
  reading(profile: Profile, batchId: string): Promise<{ health: StampHealth; depth: number | null }>;
  /** The node's Bee API as the control host reaches it, `beeApiUrlFor`. */
  beeApiUrl(profile: Profile): string;
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
    // Both batches are read at once, so the push waits for the slower of the two nodes, whose reads are bounded.
    const previous = this.readPrevious(row, readAt);
    try {
      await this.pushFor(row, urge, readAt, previous);
    } finally {
      await previous;
    }
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
      const beeApiUrl = this.deps.beeApiUrl(profile);
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
    const beeApiUrl = this.deps.beeApiUrl(profile);
    if (isLoopbackUrl(beeApiUrl)) {
      this.logProblem(
        `${profile.name}'s Bee API is ${beeApiUrl}, which reaches the dialling host alone; the web2 admin needs an address it can dial`,
      );
      return this.record('store', 'skipped-no-record');
    }
    this.loggedProblem = null;

    const previous = await previousRead;
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
    ]);
    const previousTtlSeconds = previous?.ttlSeconds ?? null;
    if (urge === 'if-changed' && !this.due(key, record.ttlSeconds, previousTtlSeconds, readAt)) return;

    const outcome = await this.send({ kind: 'store', baseUrl: link.url, token: link.token, record });
    this.sent = ANSWERED_STORE.includes(outcome)
      ? { key, ttlSeconds: record.ttlSeconds, previousTtlSeconds, at: readAt }
      : null;
    return this.record('store', outcome);
  }

  /**
   * Whether a push is owed: 30 seconds since the last one the admin answered, or a reading that moved, of the pinned
   * batch or of the one moved from.
   */
  private due(key: string, ttlSeconds: number | null, previousTtlSeconds: number | null, at: number): boolean {
    const sent = this.sent;
    if (!sent || sent.key !== key || at - sent.at >= this.intervalMs) return true;
    const elapsedSeconds = (at - sent.at) / 1000;
    return (
      lifeMoved(sent.ttlSeconds, ttlSeconds, elapsedSeconds) ||
      lifeMoved(sent.previousTtlSeconds, previousTtlSeconds, elapsedSeconds)
    );
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
