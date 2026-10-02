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

import type { Profile, ProfileKind, ProfileWithContainers } from '../../types/index.js';
import type { StoredAdminLinkSecret } from '../adminLink/ManagerAdminLinkRepository.js';
import type { ManagerEvent } from '../EventBus.js';
import { Logger } from '../Logger.js';

import type { BuiltStage, StageRecordBuilder } from './StageRecordBuilder.js';
import type { DecidedRetirement, PendingRetirement, StageRetirementStore } from './StageRetirementRepository.js';
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
  /** The retirements the admin has not answered yet, kept in the database so a restart does not lose them. */
  retirements: StageRetirementStore;
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
  /** The stage id of the deployment as its last change event named it, for one removed before its first push. */
  seenStageId: string | null;
  /** The problem last logged, so a record that cannot be built says so once and not every 30 seconds. */
  loggedProblem: string | null;
}

/**
 * Outcomes where the manager's own link kept the push from going, so the admin may hold the stage from before: one
 * pushed before a restart, or before the token was cleared. A removed stage whose pushes came to one of these is
 * retired all the same, once the link takes it.
 */
const RETIRED_THOUGH_UNPUSHED: readonly StagePushOutcome[] = ['skipped-no-link'];

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
 * before a deploy starts its uploader. A deleted deployment's stage is retired the same way, and the retirement is
 * sent again every 30 seconds and at start until the admin answers it.
 *
 * Each push comes to one outcome code, kept in memory with its time for the deployment page. The log says a
 * deployment's outcome when it changes, and never what the admin answered, its address or a token.
 */
export class StagePublisher {
  private readonly entries = new Map<string, StageEntry>();
  /** The stage ids whose retirement is being decided or sent, so a removal and the cadence never send one twice. */
  private readonly retiring = new Set<string>();
  /** The outcome last logged of each retirement still pending, so one that keeps failing says so once. */
  private readonly retireLogged = new Map<string, StagePushOutcome>();
  private readonly send: StageSender;
  private readonly clock: StageClock;
  private readonly debounceMs: number;
  private readonly intervalMs: number;
  private unsubscribe: (() => void) | null = null;
  private interval: unknown = null;
  /** Set by `stop`, after which nothing starts a push: the manager is shutting down. */
  private stopped = false;

  constructor(private readonly deps: StagePublisherDeps) {
    this.send = deps.send ?? sendStageRequest;
    this.clock = deps.clock ?? SYSTEM_CLOCK;
    this.debounceMs = deps.debounceMs ?? STAGE_PUSH_DEBOUNCE_MS;
    this.intervalMs = deps.intervalMs ?? STAGE_PUSH_INTERVAL_MS;
  }

  start(): void {
    if (this.unsubscribe || this.stopped) return;
    this.unsubscribe = this.deps.events.subscribe((event) => this.onEvent(event));
    this.interval = this.clock.setInterval(() => {
      void this.pushRunning();
      void this.retirePending();
    }, this.intervalMs);
    void this.retirePending();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.interval !== null) this.clock.clearInterval(this.interval);
    this.interval = null;
    for (const entry of this.entries.values()) {
      if (entry.timer !== undefined) this.clock.clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.again = false;
    }
  }

  /** Whether the publisher keeps anything of this deployment in memory. */
  keeps(name: string): boolean {
    return this.entries.has(name);
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
    if (!isStageKind(profile.kind) || this.stopped) return;
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
    const profiles = await this.deps.profiles.list();
    const stages = profiles.filter((profile) => isStageKind(profile.kind));
    return Promise.all(
      stages.map(async (profile) => {
        const built = await this.buildQuietly(profile, readAt);
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

  /** Sends every retirement still pending that is not being sent already: one that failed, or one from before a restart. */
  async retirePending(): Promise<void> {
    if (this.stopped) return;
    let pending: PendingRetirement[];
    try {
      pending = await this.deps.retirements.pending();
    } catch (err) {
      logger.warn(`[Stages] the pending stage retirements could not be read: ${getErrorMessage(err)}`);
      return;
    }
    await Promise.all(
      pending.map((retirement) => this.whileRetiring(retirement.stageId, () => this.retireKept(retirement))),
    );
  }

  /**
   * Pushes one deployment's record now. A push already in flight is not doubled: `skip` leaves it to answer, and
   * `follow` waits for it and then pushes once more with what has changed since.
   */
  pushNow(name: string, whileInFlight: 'skip' | 'follow' = 'follow'): Promise<StagePushOutcome | null> {
    if (this.stopped) return Promise.resolve(null);
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
        const again = entry.again;
        entry.again = false;
        if (again && !this.stopped) void this.pushNow(name, 'follow');
      });
    entry.inFlight = push;
    return push;
  }

  private onEvent(event: ManagerEvent): void {
    if (event.type === 'profile.changed') {
      if (!isStageKind(event.profile.kind)) return;
      this.entryOf(event.profile.name).seenStageId = event.profile.instance_id;
      this.schedule(event.profile.name);
    } else if (event.type === 'profile.deleted') {
      void this.whileRetiring(event.instanceId, () => this.retire(event));
    }
  }

  /** Gathers change events for one deployment into one push, a short while after the first. */
  private schedule(name: string): void {
    if (this.stopped) return;
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
      entry = { again: false, last: null, pushed: null, seenStageId: null, loggedProblem: null };
      this.entries.set(name, entry);
    }
    return entry;
  }

  private async push(name: string, entry: StageEntry): Promise<StagePushOutcome | null> {
    // Taken as the row is read, before any slower reading: the moment the record says it was observed.
    const readAt = new Date(this.clock.now());
    const profile = await this.deps.profiles.find(name);
    if (!profile || !isStageKind(profile.kind)) {
      // A name that is gone, or is no stage now, never pushed and never seen as one: nothing to retire, so nothing to
      // keep. One its change event named waits for its removal event, which retires it and drops it then.
      if (!entry.pushed && !entry.seenStageId && entry.timer === undefined && this.entries.get(name) === entry) {
        this.entries.delete(name);
      }
      return null;
    }
    const link = await this.deps.link.storedLink();
    if (!link.url || !link.token) return this.record(entry, name, 'skipped-no-link');

    const built = await this.buildQuietly(profile, readAt);
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

  /** Runs one stage's retirement unless one is running already, which then answers for it. */
  private async whileRetiring(stageId: string, retire: () => Promise<void>): Promise<void> {
    if (this.retiring.has(stageId)) return;
    this.retiring.add(stageId);
    try {
      await retire();
    } finally {
      this.retiring.delete(stageId);
    }
  }

  /**
   * Retires a deleted deployment's stage at the link its records went to, with the moment its row was deleted, so a
   * record read before that and arriving after it cannot bring the stage back. One removed before its first push is
   * retired at the current link too, by the instance id the removal carries, whether or not this manager has seen it
   * since it started: the admin keeps a retirement of a stage it never stored as a tombstone, and may hold one pushed
   * before a restart. One it skipped since it started is left as it is.
   *
   * The retirement is kept in the database until the admin answers it, `retired` or `not-retired`, and sent again
   * every 30 seconds and at start until then. One whose link has moved to another origin since its last push is
   * dropped, and the log says so.
   */
  private async retire(gone: Extract<ManagerEvent, { type: 'profile.deleted' }>): Promise<void> {
    const { name } = gone;
    try {
      const decided = await this.decide(name, gone.instanceId, gone.kind);
      if (decided === 'no-stage') return;
      if (decided === 'skipped') {
        await this.deps.retirements.remove(gone.instanceId);
        return;
      }
      const kept = await this.deps.retirements.keep({
        stageId: gone.instanceId,
        name,
        deletedAt: gone.deletedAt,
        origin: decided.origin,
      });
      await this.sendRetirement(kept);
    } catch (err) {
      logger.warn(`[Stages] ${name}: removed, and retiring its stage failed (${getErrorMessage(err)})`);
    }
  }

  /**
   * Sends a retirement kept in the database. One the removal wrote and nothing decided, because the manager stopped
   * between them, is decided now, as of this moment: no record of the stage can be read after its row was deleted.
   */
  private async retireKept(retirement: PendingRetirement): Promise<void> {
    try {
      let kept: DecidedRetirement;
      if (retirement.deletedAt === null) {
        const decided = await this.decide(retirement.name, retirement.stageId, null);
        if (decided === 'skipped' || decided === 'no-stage') {
          await this.deps.retirements.remove(retirement.stageId);
          return;
        }
        kept = await this.deps.retirements.keep({
          ...retirement,
          deletedAt: new Date(this.clock.now()).toISOString(),
          origin: decided.origin,
        });
      } else {
        kept = { ...retirement, deletedAt: retirement.deletedAt };
      }
      await this.sendRetirement(kept);
    } catch (err) {
      logger.warn(`[Stages] ${retirement.name}: removed, and retiring its stage failed (${getErrorMessage(err)})`);
    }
  }

  /**
   * What this publisher kept of a removed deployment decides its retirement, and is dropped: `skipped` for one it
   * skipped since it started, else the origin its records went to, or null for one it never pushed, or whose pushes
   * the manager's own link stopped for want of a token. `no-stage` for a
   * kind that runs no uploader. An entry that names another stage, a later deployment of the same name, is not this
   * one's and stays.
   */
  private async decide(
    name: string,
    stageId: string,
    kind: ProfileKind | null,
  ): Promise<{ origin: string | null } | 'skipped' | 'no-stage'> {
    let entry = this.entries.get(name);
    const named = entry?.pushed?.stageId ?? entry?.seenStageId ?? null;
    if (named !== null && named !== stageId) entry = undefined;
    if (entry) {
      if (entry.timer !== undefined) this.clock.clearTimeout(entry.timer);
      entry.again = false;
      this.entries.delete(name);
    }
    if (!entry) return kind === null || isStageKind(kind) ? { origin: null } : 'no-stage';
    // A push in flight may be the first to reach the admin, so its answer decides whether there is a stage to retire.
    await entry.inFlight;
    if (entry.pushed) return { origin: entry.pushed.origin };
    // One removed before its first push is retired all the same, which the admin keeps as a tombstone, so a record of
    // it that arrives late does not register a deployment that is gone. So is one whose pushes stopped at the
    // manager's own link, which the admin may hold from before: a token cleared to rotate it. It waits for the link to
    // take it.
    return entry.last === null || RETIRED_THOUGH_UNPUSHED.includes(entry.last.outcome) ? { origin: null } : 'skipped';
  }

  /** Sends one retirement, and takes it out once the admin answered it or its link moved to another origin. */
  private async sendRetirement(kept: DecidedRetirement): Promise<void> {
    const link = await this.deps.link.storedLink();
    // Kept until the link has an address and a token again.
    if (!link.url || !link.token) return;
    if (kept.origin !== null && adminOriginOf(link.url) !== kept.origin) {
      logger.warn(
        `[Stages] ${kept.name}: removed, and its stage was not retired: the web2 admin link has changed since`,
      );
      await this.forget(kept.stageId);
      return;
    }
    const outcome = await this.send({
      kind: 'retire',
      baseUrl: link.url,
      token: link.token,
      stageId: kept.stageId,
      observedAt: kept.deletedAt,
    });
    const line = `[Stages] ${kept.name}: removed, and retiring its stage came to ${outcome}`;
    if (outcome === 'retired' || outcome === 'not-retired') {
      logger.info(line);
      await this.forget(kept.stageId);
    } else if (this.retireLogged.get(kept.stageId) !== outcome) {
      logger.warn(`${line}; it is sent again every 30 seconds until the admin answers`);
      this.retireLogged.set(kept.stageId, outcome);
    }
  }

  private async forget(stageId: string): Promise<void> {
    this.retireLogged.delete(stageId);
    await this.deps.retirements.remove(stageId);
  }

  private async buildQuietly(profile: ProfileWithContainers, readAt: Date): Promise<BuiltStage> {
    try {
      return await this.deps.builder.build(profile, readAt);
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
  return {
    ...record,
    ingest: { ...ingest, hasSrtPassphrase: srtPassphrase !== null },
    adminToken: record.adminToken && { kind: record.adminToken.kind },
  };
}
