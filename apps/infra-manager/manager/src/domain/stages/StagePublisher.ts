import {
  adminOriginOf,
  type ConsoleStage,
  type ConsoleStageRecord,
  getErrorMessage,
  isStageKind,
  sameAdminOrigin,
  type StagePushOutcome,
  type StagePushState,
} from '@streaming-infra-manager/common';
import type { StageRecord } from '@streaming-monorepo/contracts';

import type { Profile, ProfileWithContainers } from '../../types/index.js';
import type { StoredAdminLinkSecret } from '../adminLink/ManagerAdminLinkRepository.js';
import type { ManagerEvent } from '../EventBus.js';
import { Logger } from '../Logger.js';

import type { BuiltStage, StageRecordBuilder } from './StageRecordBuilder.js';
import { sendStageRequest, type StageSender } from './stageRequest.js';

const logger = Logger.getInstance();

/** How long a burst of change events for one deployment is gathered into one push. */
export const STAGE_PUSH_DEBOUNCE_MS = 1_000;
/** How often the record of every running stage is pushed again, so the admin's readings stay fresh. */
export const STAGE_PUSH_INTERVAL_MS = 30_000;
/** The longest a deploy waits for the push before it starts the uploader. */
export const STAGE_PUSH_BEFORE_START_MS = 10_000;

/** The timers the publisher runs on, so a test can move time itself. */
export interface StageClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const SYSTEM_CLOCK: StageClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface StagePublisherDeps {
  /** Every deployment with its containers, and one by name or null. */
  profiles: {
    list(): Promise<ProfileWithContainers[]>;
    find(name: string): Promise<ProfileWithContainers | null>;
  };
  builder: Pick<StageRecordBuilder, 'build'>;
  /** The manager's web2 admin link and its token, the registrar's. */
  link: { storedLink(): Promise<StoredAdminLinkSecret> };
  events: { subscribe(listener: (event: ManagerEvent) => void): () => void };
  send?: StageSender;
  clock?: StageClock;
  debounceMs?: number;
  intervalMs?: number;
}

/** What the publisher keeps of one deployment between pushes, in memory alone. */
interface StageEntry {
  timer?: unknown;
  inFlight?: Promise<StagePushOutcome | null>;
  /** A trigger came while a push was in flight, so one more follows it. */
  again: boolean;
  last: StagePushState | null;
  /** The stage id and the link origin the last request went to, which a retirement goes to. */
  pushed: { stageId: string; origin: string } | null;
  /** The problem last logged, so a record that cannot be built says so once and not every 30 seconds. */
  loggedProblem: string | null;
}

/** Outcomes where the admin was asked, so a later retirement has somewhere to go. */
const ASKED: readonly StagePushOutcome[] = [
  'stored',
  'older-ignored',
  'refused-token',
  'refused-record',
  'unreachable',
  'redirected',
  'not-admin',
];

/**
 * The stage publisher: for every deployment that runs a stream uploader and whose effective `ADMIN_API_URL` is on
 * the origin of the manager's web2 admin link, it pushes the deployment's stage record to that link with the link's
 * stored token. It pushes when the deployment changes, gathered per deployment, every 30 seconds while it runs, and
 * before a deploy starts its uploader. A deleted deployment's stage is retired the same way.
 *
 * Each push comes to one outcome code, kept in memory with its time for the deployment page. The log says a
 * deployment's outcome when it changes, and never what the admin answered, its address or a token.
 */
export class StagePublisher {
  private readonly entries = new Map<string, StageEntry>();
  private readonly send: StageSender;
  private readonly clock: StageClock;
  private readonly debounceMs: number;
  private readonly intervalMs: number;
  private unsubscribe: (() => void) | null = null;
  private interval: unknown = null;

  constructor(private readonly deps: StagePublisherDeps) {
    this.send = deps.send ?? sendStageRequest;
    this.clock = deps.clock ?? SYSTEM_CLOCK;
    this.debounceMs = deps.debounceMs ?? STAGE_PUSH_DEBOUNCE_MS;
    this.intervalMs = deps.intervalMs ?? STAGE_PUSH_INTERVAL_MS;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.events.subscribe((event) => this.onEvent(event));
    this.interval = this.clock.setInterval(() => void this.pushRunning(), this.intervalMs);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.interval !== null) this.clock.clearInterval(this.interval);
    this.interval = null;
    for (const entry of this.entries.values()) {
      if (entry.timer !== undefined) this.clock.clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  /** The last push of one deployment's record, or null before any. */
  lastPush(name: string): StagePushState | null {
    return this.entries.get(name)?.last ?? null;
  }

  /**
   * The push a deploy makes before it starts the uploader, so the uploader's first call finds its token known. It
   * waits for a push already in flight and then pushes once more, gives up after ten seconds, and never throws: a
   * failed push logs a warning and the deploy goes on.
   */
  async beforeUploaderStart(profile: Pick<Profile, 'name' | 'kind'>): Promise<void> {
    if (!isStageKind(profile.kind)) return;
    let timer: unknown;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = this.clock.setTimeout(() => resolve('timeout'), STAGE_PUSH_BEFORE_START_MS);
    });
    try {
      const outcome = await Promise.race([this.pushNow(profile.name, 'follow'), timeout]);
      if (outcome === 'timeout') {
        logger.warn(`[Stages] ${profile.name}: the push before the uploader starts took too long; the deploy goes on`);
      } else if (outcome !== null && ASKED.includes(outcome) && outcome !== 'stored' && outcome !== 'older-ignored') {
        logger.warn(
          `[Stages] ${profile.name}: the push before the uploader starts came to ${outcome}; the deploy goes on`,
        );
      }
    } catch (err) {
      logger.warn(
        `[Stages] ${profile.name}: the push before the uploader starts failed (${getErrorMessage(err)}); the deploy goes on`,
      );
    } finally {
      this.clock.clearTimeout(timer);
    }
  }

  /** Every stage the manager would push, with how its last push went and without the SRT passphrase. */
  async consoleStages(): Promise<ConsoleStage[]> {
    const readAt = new Date(this.clock.now());
    const [profiles, link] = await Promise.all([this.deps.profiles.list(), this.deps.link.storedLink()]);
    const stages = profiles.filter((profile) => isStageKind(profile.kind));
    return Promise.all(
      stages.map(async (profile) => {
        const built = await this.buildQuietly(profile, link, readAt);
        return {
          name: profile.name,
          record: built.ok ? consoleRecordOf(built.record) : null,
          problem: built.ok ? null : built.problem,
          lastPush: this.lastPush(profile.name),
        };
      }),
    );
  }

  /** Pushes every running stage's record, skipping one whose push is still in flight. */
  async pushRunning(): Promise<void> {
    let profiles: ProfileWithContainers[];
    try {
      profiles = await this.deps.profiles.list();
    } catch (err) {
      logger.warn(`[Stages] the deployments could not be listed for the periodic push: ${getErrorMessage(err)}`);
      return;
    }
    await Promise.all(
      profiles
        .filter((profile) => isStageKind(profile.kind) && profile.status === 'RUNNING')
        .map((profile) => this.pushNow(profile.name, 'skip')),
    );
  }

  /**
   * Pushes one deployment's record now. A push already in flight is not doubled: `skip` leaves it to answer, and
   * `follow` waits for it and then pushes once more with what has changed since.
   */
  pushNow(name: string, whileInFlight: 'skip' | 'follow' = 'follow'): Promise<StagePushOutcome | null> {
    const entry = this.entryOf(name);
    if (entry.inFlight) {
      if (whileInFlight === 'skip') return entry.inFlight;
      entry.again = true;
      return entry.inFlight.then(() => (entry.inFlight ? entry.inFlight : this.pushNow(name, 'follow')));
    }
    const push = this.push(name, entry)
      .catch((err: unknown) => {
        logger.warn(`[Stages] ${name}: the push failed (${getErrorMessage(err)})`);
        return null;
      })
      .finally(() => {
        entry.inFlight = undefined;
        if (entry.again) {
          entry.again = false;
          void this.pushNow(name, 'follow');
        }
      });
    entry.inFlight = push;
    return push;
  }

  private onEvent(event: ManagerEvent): void {
    if (event.type === 'profile.changed') {
      if (isStageKind(event.profile.kind)) this.schedule(event.profile.name);
    } else if (event.type === 'profile.deleted') {
      void this.retire(event.name, new Date(this.clock.now()));
    }
  }

  /** Gathers change events for one deployment into one push, a short while after the first. */
  private schedule(name: string): void {
    const entry = this.entryOf(name);
    if (entry.timer !== undefined) return;
    entry.timer = this.clock.setTimeout(() => {
      entry.timer = undefined;
      void this.pushNow(name, 'follow');
    }, this.debounceMs);
  }

  private entryOf(name: string): StageEntry {
    let entry = this.entries.get(name);
    if (!entry) {
      entry = { again: false, last: null, pushed: null, loggedProblem: null };
      this.entries.set(name, entry);
    }
    return entry;
  }

  private async push(name: string, entry: StageEntry): Promise<StagePushOutcome | null> {
    // Taken as the row is read, before any slower reading: the moment the record says it was observed.
    const readAt = new Date(this.clock.now());
    const profile = await this.deps.profiles.find(name);
    if (!profile || !isStageKind(profile.kind)) return null;
    const link = await this.deps.link.storedLink();
    if (!link.url || !link.token) return this.record(entry, name, 'skipped-no-link');

    const built = await this.buildQuietly(profile, link, readAt);
    if (!built.ok) {
      if (entry.loggedProblem !== built.problem) {
        logger.warn(`[Stages] ${name}: no stage record: ${built.problem}`);
        entry.loggedProblem = built.problem;
      }
      return this.record(entry, name, 'skipped-no-record');
    }
    entry.loggedProblem = null;
    if (built.adminApiUrl === '') return this.record(entry, name, 'skipped-not-linked');
    if (!sameAdminOrigin(built.adminApiUrl, link.url)) return this.record(entry, name, 'skipped-other-origin');

    const outcome = await this.send({ kind: 'store', baseUrl: link.url, token: link.token, record: built.record });
    if (ASKED.includes(outcome)) {
      entry.pushed = { stageId: built.record.stageId, origin: adminOriginOf(link.url) ?? '' };
    }
    return this.record(entry, name, outcome);
  }

  /**
   * Retires a deleted deployment's stage at the link its records went to, with the moment the manager saw it gone,
   * so a record read before that and arriving after it cannot bring the stage back. One this manager has not pushed
   * since it started, or whose link has moved to another origin since, is left as it is and the log says so.
   */
  private async retire(name: string, goneAt: Date): Promise<void> {
    const entry = this.entries.get(name);
    if (entry?.timer !== undefined) this.clock.clearTimeout(entry.timer);
    if (entry) entry.again = false;
    this.entries.delete(name);
    if (!entry) return;
    try {
      // A push in flight may be the first to reach the admin, so its answer decides whether there is a stage to retire.
      await entry.inFlight;
      if (!entry.pushed) return;
      const link = await this.deps.link.storedLink();
      if (!link.url || !link.token || adminOriginOf(link.url) !== entry.pushed.origin) {
        logger.warn(`[Stages] ${name}: removed, and its stage was not retired: the web2 admin link has changed since`);
        return;
      }
      const outcome = await this.send({
        kind: 'retire',
        baseUrl: link.url,
        token: link.token,
        stageId: entry.pushed.stageId,
        observedAt: goneAt.toISOString(),
      });
      const line = `[Stages] ${name}: removed, and retiring its stage came to ${outcome}`;
      if (outcome === 'retired' || outcome === 'not-retired') logger.info(line);
      else logger.warn(line);
    } catch (err) {
      logger.warn(`[Stages] ${name}: removed, and its stage was not retired (${getErrorMessage(err)})`);
    }
  }

  private async buildQuietly(
    profile: ProfileWithContainers,
    link: StoredAdminLinkSecret,
    readAt: Date,
  ): Promise<BuiltStage> {
    try {
      return await this.deps.builder.build(profile, { token: link.token }, readAt);
    } catch (err) {
      return { ok: false, problem: getErrorMessage(err), stageId: profile.instance_id };
    }
  }

  /** Keeps the outcome with its time, and logs it when it differs from the last one. */
  private record(entry: StageEntry, name: string, outcome: StagePushOutcome): StagePushOutcome {
    const before = entry.last?.outcome;
    entry.last = { outcome, at: new Date(this.clock.now()).toISOString() };
    if (before !== outcome) {
      const line = `[Stages] ${name}: pushing its stage record came to ${outcome}`;
      if (outcome === 'stored' || outcome === 'older-ignored') logger.info(line);
      else logger.warn(line);
    }
    return outcome;
  }
}

/** A record as the manager's own console is answered it, whose SRT passphrase stays in the manager. */
export function consoleRecordOf(record: StageRecord): ConsoleStageRecord {
  const { srtPassphrase, ...ingest } = record.ingest;
  return { ...record, ingest: { ...ingest, hasSrtPassphrase: srtPassphrase !== null } };
}
