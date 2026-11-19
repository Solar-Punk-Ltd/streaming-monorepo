import {
  type CatalogueNodeAnswer,
  type DeploymentSettingEntry,
  type DeploymentSettingsCatalog,
  getErrorMessage,
  INGEST_READ,
  type IngestHealthReading,
  parseBeePublishers,
  PURCHASE_LIVE_READ_GAP_MS,
  purchaseReplaceProblem,
  RTMP_INGEST_MEASURED,
  RTMP_INGEST_UNATTRIBUTED,
  SRT_INGEST_MEASURED,
} from '@streaming-infra-manager/common';

import { TRANSITIONAL_STATUSES } from '../../types/index.js';
import type { Profile } from '../../types/index.js';
import { CatalogueNodeInputError, ManagerSettingsChangedError, ProfileBusyError } from '../errors/index.js';
import type {
  PurchasedCatalogueBatches,
  PurchasedRungBatches,
  PurchaseFollower,
  PurchaseStageApplier,
  PurchaseStageLook,
  RoleBatchReading,
} from '../funding/purchaseFollowUpPorts.js';
import type { IngestHealthService } from '../ingestHealth/IngestHealthService.js';
import { Logger } from '../Logger.js';
import type { ProfileRepository } from '../ProfileRepository.js';
import type { DeploymentSettingsService } from '../settings/DeploymentSettingsService.js';
import type { StampService } from '../StampService.js';

import type { CatalogueDesignationService } from './CatalogueDesignationService.js';
import type { StagePoolStrings } from './StagePoolStrings.js';

/**
 * The parts of the manager that put a batch bought through the funding API to use, behind the three ports of
 * `../funding/purchaseFollowUpPorts.ts`: a rung's batch set as the Buy form sets one, a stage applied as its settings
 * Apply runs, and the catalogue batch designated as a move and released. `docs/features/postage-stamps.md`, "Bought
 * from the admin", is the page.
 */

const logger = Logger.getInstance();

/** What the three ports are built from: the services the manager's console drives the same parts with. */
export interface PurchaseFollowUpPortsDeps {
  profiles: Pick<ProfileRepository, 'findByName' | 'list'>;
  stamps: Pick<StampService, 'setStamp' | 'stampHealthFor'>;
  poolStrings: Pick<StagePoolStrings, 'followersOf'>;
  settings: Pick<DeploymentSettingsService, 'catalog' | 'apply'>;
  ingest: Pick<IngestHealthService, 'read'>;
  catalogue: Pick<CatalogueDesignationService, 'read' | 'designate' | 'release'>;
  /** Waits between the two readings of whether a broadcast is live: a timer by default, none in the unit tests. */
  pause?: (ms: number) => Promise<void>;
  /** The clock, in ms: `Date.now` by default. */
  now?: () => number;
}

/** The three ports the funding side's purchase follow-up calls. */
export interface PurchaseFollowUpPorts {
  rungs: PurchasedRungBatches;
  stages: PurchaseStageApplier;
  catalogue: PurchasedCatalogueBatches;
}

/**
 * Builds the three ports over the manager's own services. What a port rejects with reaches the web2 admin, so it is a
 * sentence of this module's own, {@link PurchaseFollowUpError}, or the catalogue designation's own refusal. Any other
 * failure, which can carry a host's address, is logged here and answered as a plain sentence.
 */
export function purchaseFollowUpPorts(deps: PurchaseFollowUpPortsDeps): PurchaseFollowUpPorts {
  const rungs = new RungBatches(deps);
  const stages = new StageApplier(deps);
  const catalogue = new CatalogueBatches(deps);
  return {
    rungs: {
      current: (profileName) =>
        guarded(`reading the batch of ${profileName}`, 'The batch set on the deployment could not be read.', () =>
          rungs.current(profileName),
        ),
      set: (input) =>
        guarded(
          `setting batch ${shortBatch(input.batchId)} on ${input.profileName}`,
          'The bought batch could not be set on its deployment.',
          () => rungs.set(input),
        ),
    },
    stages: {
      look: (input) =>
        guarded(`looking at stage ${input.stageId}`, 'The stage could not be read.', () => stages.look(input)),
    },
    catalogue: {
      current: (profileName) =>
        guarded(`reading the catalogue batch of ${profileName}`, 'The catalogue batch could not be read.', () =>
          catalogue.current(profileName),
        ),
      designate: (input) =>
        guarded(
          `designating batch ${shortBatch(input.batchId)} as the catalogue batch`,
          'The bought batch could not be designated as the catalogue batch.',
          () => catalogue.designate(input),
        ),
      release: (input) =>
        guarded(
          `releasing batch ${shortBatch(input.previousBatchId)}`,
          'The previous catalogue batch could not be released.',
          () => catalogue.release(input),
        ),
    },
  };
}

/** A sentence a port rejects with, which names no host and no address, and reaches the web2 admin as it is. */
export class PurchaseFollowUpError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PurchaseFollowUpError';
  }
}

/** What the admin reads where the manager's log holds the detail. */
const SEE_THE_LOG = 'The manager’s log says why.';

/**
 * Runs one call of a port. A rejection with a sentence of this module's own, or with the catalogue designation's own
 * refusal, passes as it is; any other is logged with its detail and answered as `plain`, since its text can name a
 * host.
 */
async function guarded<T>(what: string, plain: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof PurchaseFollowUpError || err instanceof CatalogueNodeInputError) throw err;
    logger.warn(`[BatchPurchase] ${what} failed: ${getErrorMessage(err)}`);
    throw new PurchaseFollowUpError(`${plain} ${SEE_THE_LOG}`, { cause: err });
  }
}

/**
 * The keys a stage's batch reaches its uploader by: `BEE_PUBLISHERS`, the pool string of an ABR stage, and `STAMP`,
 * the batch of a stage that uploads to its own Bee node.
 */
export const PURCHASE_BATCH_KEYS: readonly string[] = ['BEE_PUBLISHERS', 'STAMP'];

/** Who the manager's own services log a purchase's change as, in place of a user. */
export function purchaseActor(requestId: string): string {
  return `the batch purchase ${requestId}`;
}

/** Who a stage's Apply started by a purchase is logged as. The look is not told which purchase asks. */
const PURCHASE_APPLY_ACTOR = 'a batch purchase';

/** How often a designation or a release that lost the revision to another writer reads it again and tries again. */
const REVISION_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A batch id as the manager keeps one here: 64 hex digits, no `0x`, in lower case. */
function normalBatchId(batchId: string): string {
  return batchId.replace(/^0x/i, '').toLowerCase();
}

/** A batch id as a sentence names it: its first eight hex digits. */
function shortBatch(batchId: string): string {
  return `${normalBatchId(batchId).slice(0, 8)}…`;
}

/** Whether a value of one of {@link PURCHASE_BATCH_KEYS} pays with this batch: a pool string naming it, or the batch. */
function carriesBatch(value: string | null, batchId: string): boolean {
  if (value === null || value.trim() === '') return false;
  const entries = parseBeePublishers(value);
  if (entries && entries.length > 0) return entries.some((entry) => normalBatchId(entry.batchId) === batchId);
  return normalBatchId(value.trim()) === batchId;
}

/** Whether the running uploader pays with this batch: a batch key whose running value is the stored one and names it. */
function runsWithBatch(entries: readonly DeploymentSettingEntry[], batchId: string): boolean {
  return entries.some(
    (entry) =>
      PURCHASE_BATCH_KEYS.includes(entry.key) &&
      entry.running === 'same' &&
      (carriesBatch(entry.runningValue, batchId) || carriesBatch(entry.value, batchId)),
  );
}

/** Whether a stage's saved settings name this batch, so the next deploy or Apply pays with it. */
function savedWithBatch(entries: readonly DeploymentSettingEntry[], batchId: string): boolean {
  return entries.some((entry) => PURCHASE_BATCH_KEYS.includes(entry.key) && carriesBatch(entry.value, batchId));
}

/**
 * The look of a stage whose running uploader is behind on another saved setting beside the batch, naming the keys,
 * or null when the batch is the only one. An Apply would roll those out too, so an operator applies the stage.
 */
function waitingSettings(catalog: DeploymentSettingsCatalog): PurchaseStageLook | null {
  const waiting = catalog.drift.keys.filter((key) => !PURCHASE_BATCH_KEYS.includes(key));
  if (waiting.length === 0) return null;
  return {
    apply: 'waiting_settings',
    message: `Other saved settings wait for an Apply beside the batch: ${waiting.join(', ')}. Apply the stage in the manager.`,
  };
}

type Liveness = 'live' | 'idle' | 'unknown';

/** What one reading of the engine's ingest says of a broadcast. */
function livenessOf(reading: IngestHealthReading): Liveness {
  if (reading.state !== INGEST_READ) return 'unknown';
  if (reading.srt.state === SRT_INGEST_MEASURED && reading.srt.connections > 0) return 'live';
  if (reading.rtmp.state === RTMP_INGEST_MEASURED && reading.rtmp.connections > 0) return 'live';
  if (reading.rtmp.state === RTMP_INGEST_UNATTRIBUTED) return 'unknown';
  return 'idle';
}

/** The rung side: a batch set on a deployment's own Bee node as the Buy form sets one. */
class RungBatches implements PurchasedRungBatches {
  constructor(private readonly deps: PurchaseFollowUpPortsDeps) {}

  async current(profileName: string): Promise<RoleBatchReading> {
    const profile = await profileNamed(this.deps, profileName);
    const batchId = profile.stamp_id ? normalBatchId(profile.stamp_id) : null;
    const health = await this.deps.stamps.stampHealthFor(profile, profile.stamp_id);
    return { batchId, state: health.state };
  }

  async set(input: { profileName: string; batchId: string; requestId: string }): Promise<PurchaseFollower[]> {
    const profile = await profileNamed(this.deps, input.profileName);
    const batchId = normalBatchId(input.batchId);
    const setNow = profile.stamp_id ? normalBatchId(profile.stamp_id) : null;
    if (setNow !== batchId) {
      if (setNow !== null) {
        // Another batch than the one the purchase replaces may have been set meanwhile; one that works stays.
        const state = (await this.deps.stamps.stampHealthFor(profile, profile.stamp_id)).state;
        const problem = purchaseReplaceProblem('rung', state);
        if (problem) {
          throw new PurchaseFollowUpError(
            `The bought batch was not set on ${profile.name}, because batch ${shortBatch(setNow)} is set there now. ${problem}`,
          );
        }
      }
      // The Buy form's own set, which brings the stored pool string of every stage that follows the rung up to date.
      await this.deps.stamps.setStamp(profile.name, batchId);
      logger.info(
        `[BatchPurchase] ${purchaseActor(input.requestId)} set batch ${shortBatch(batchId)} on ${profile.name}`,
      );
    }
    const followers = await this.deps.poolStrings.followersOf(profile.name);
    // A deployment that is no rung of a pool is a stage that uploads to its own Bee node.
    if (followers === null) return [{ stageId: profile.instance_id, name: profile.name, following: true }];
    return followers.map(({ stage, following }) => ({ stageId: stage.instance_id, name: stage.name, following }));
  }
}

/** An Apply this process started for a purchase, and how it ended when it ended without the batch. */
interface StartedApply {
  at: number;
  error: string | null;
  /** Whether the manager's log holds why it failed, so a look that finds it failed again logs nothing. */
  logged: boolean;
}

/**
 * The Applies a look started are kept by stage and batch: several rung purchases can follow one stage, and each keeps
 * its own, so one purchase's look never takes another's failed Apply for none and starts the Apply again.
 */
function startedKey(stageId: string, batchId: string): string {
  return `${stageId}:${batchId}`;
}

/**
 * The stage side: one look at one stage, which moves it one step at most. The Apply is the stage's settings Apply,
 * the one **Apply now** runs, and the look remembers in this process the Applies it started, so one that ended
 * without the batch answers `failed` until the follow-up is asked to check again. A manager that restarted has
 * forgotten them, and starts the Apply again where one is due.
 */
class StageApplier implements PurchaseStageApplier {
  /** By {@link startedKey}. */
  private readonly started = new Map<string, StartedApply>();
  private readonly pause: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: PurchaseFollowUpPortsDeps) {
    this.pause = deps.pause ?? sleep;
    this.now = deps.now ?? (() => Date.now());
  }

  async look(input: {
    stageId: string;
    batchId: string;
    force: boolean;
    retryFailed: boolean;
  }): Promise<PurchaseStageLook> {
    const batchId = normalBatchId(input.batchId);
    const profiles = await this.deps.profiles.list();
    const stage = profiles.find((profile) => profile.instance_id === input.stageId);
    if (!stage) {
      this.started.delete(startedKey(input.stageId, batchId));
      return { apply: 'stopped', message: 'The stage is no longer on this manager.' };
    }
    if ((TRANSITIONAL_STATUSES as readonly string[]).includes(stage.status)) {
      return { apply: 'applying', message: null };
    }

    const catalog = await this.deps.settings.catalog(stage.name);
    if (runsWithBatch(catalog.entries, batchId)) {
      this.started.delete(startedKey(input.stageId, batchId));
      return { apply: 'applied', message: null };
    }
    if (!catalog.running) {
      this.started.delete(startedKey(input.stageId, batchId));
      return { apply: 'stopped', message: 'The stage does not run. Its next start pays with the new batch.' };
    }
    if (!(await this.follows(stage, batchId, profiles))) {
      return {
        apply: 'not_following',
        message: 'The stage’s pool string was not taken from this rung’s pool, so the manager leaves it as it is.',
      };
    }

    const waiting = waitingSettings(catalog);
    if (waiting) return waiting;
    if (!savedWithBatch(catalog.entries, batchId)) {
      return {
        apply: 'failed',
        message: 'The stage’s saved settings do not name the new batch, so an Apply would not bring it.',
      };
    }

    const earlier = this.started.get(startedKey(input.stageId, batchId));
    if (earlier) {
      if (!input.retryFailed) return { apply: 'failed', message: earlier.error ?? this.endedWithout(stage, earlier) };
      // Asked to check again: the failure is taken up, and a wait for a broadcast before the Apply is no failure.
      this.started.delete(startedKey(input.stageId, batchId));
    }

    if (!input.force) {
      const live = await this.liveness(stage);
      if (live === 'live') return { apply: 'waiting_live', message: null };
      if (live === 'unknown') {
        return {
          apply: 'waiting_unknown',
          message:
            'The manager cannot tell whether a broadcast is live on this stage, so it waits for a restart from the admin.',
        };
      }
    }

    // Read again after the live readings, or a restart's word: the Apply rolls out every setting the stage is behind
    // on, and one saved meanwhile is not the purchase's to roll out.
    const now = await this.deps.settings.catalog(stage.name);
    if (runsWithBatch(now.entries, batchId)) return { apply: 'applied', message: null };
    const waitingNow = waitingSettings(now);
    if (waitingNow) return waitingNow;
    return this.apply(stage, batchId);
  }

  /**
   * Whether the stage takes the rung's batch: a stage that is the deployment the batch was set on, or one whose pool
   * string is the pool's own. One whose string was pasted, or names that rung no more, does not.
   */
  private async follows(stage: Profile, batchId: string, profiles: readonly Profile[]): Promise<boolean> {
    const rung = profiles.find((profile) => profile.stamp_id && normalBatchId(profile.stamp_id) === batchId);
    if (!rung || rung.name === stage.name) return true;
    const followers = await this.deps.poolStrings.followersOf(rung.name);
    if (followers === null) return true;
    return followers.some((follower) => follower.stage.name === stage.name && follower.following);
  }

  /** Two readings of the stage's ingest, {@link PURCHASE_LIVE_READ_GAP_MS} apart: live if either is. */
  private async liveness(stage: Profile): Promise<Liveness> {
    const first = await this.readLiveness(stage);
    if (first === 'live') return 'live';
    await this.pause(PURCHASE_LIVE_READ_GAP_MS);
    const second = await this.readLiveness(stage);
    if (second === 'live') return 'live';
    return first === 'unknown' || second === 'unknown' ? 'unknown' : 'idle';
  }

  private async readLiveness(stage: Profile): Promise<Liveness> {
    try {
      return livenessOf(await this.deps.ingest.read(stage.name));
    } catch (err) {
      logger.warn(`[BatchPurchase] ${stage.name}: its ingest could not be read: ${getErrorMessage(err)}`);
      return 'unknown';
    }
  }

  private async apply(stage: Profile, batchId: string): Promise<PurchaseStageLook> {
    const at = this.now();
    try {
      await this.deps.settings.apply(stage.name, stage.instance_id, PURCHASE_APPLY_ACTOR);
    } catch (err) {
      // A deploy of the stage started since it was read, another purchase's Apply among them. It writes the pool's
      // current string, so the next look finds the batch there, or starts an Apply of its own then.
      if (err instanceof ProfileBusyError) {
        logger.info(`[BatchPurchase] ${stage.name}: a deploy of it is under way, so it was not applied again`);
        return { apply: 'applying', message: null };
      }
      const error = `The Apply did not start. ${SEE_THE_LOG}`;
      this.started.set(startedKey(stage.instance_id, batchId), { at, error, logged: true });
      logger.warn(`[BatchPurchase] ${stage.name}: the Apply did not start: ${getErrorMessage(err)}`);
      return { apply: 'failed', message: error };
    }
    this.started.set(startedKey(stage.instance_id, batchId), { at, error: null, logged: false });
    logger.info(`[BatchPurchase] ${stage.name}: applied for batch ${shortBatch(batchId)}`);
    return { apply: 'applying', message: null };
  }

  /**
   * Why an Apply this process started ended without the batch, in a sentence that names no host. The deploy's own
   * error since, where it left one, can name one: it goes to the manager's log, once, and the stage's page shows it.
   */
  private endedWithout(stage: Profile, started: StartedApply): string {
    const since = stage.last_error_at !== null && stage.last_error_at.getTime() >= started.at;
    if (!since || !stage.last_error) return 'The Apply ended, and the uploader does not pay with the new batch.';
    if (!started.logged) {
      logger.warn(`[BatchPurchase] ${stage.name}: the Apply failed: ${stage.last_error}`);
      started.logged = true;
    }
    return `The Apply failed. ${SEE_THE_LOG}`;
  }
}

/** The catalogue side: the designation the Manager settings page makes, as a move, and its release. */
class CatalogueBatches implements PurchasedCatalogueBatches {
  constructor(private readonly deps: PurchaseFollowUpPortsDeps) {}

  async current(profileName: string): Promise<RoleBatchReading> {
    const designation = (await this.deps.catalogue.read()).designation;
    if (!designation || designation.profileName !== profileName) return { batchId: null, state: 'none' };
    const batchId = normalBatchId(designation.batchId);
    const profile = await this.deps.profiles.findByName(profileName);
    if (!profile) return { batchId, state: 'unknown' };
    return { batchId, state: (await this.deps.stamps.stampHealthFor(profile, batchId)).state };
  }

  async designate(input: {
    profileName: string;
    batchId: string;
    requestId: string;
  }): Promise<{ previousBatchId: string | null }> {
    const batchId = normalBatchId(input.batchId);
    for (let attempt = 1; ; attempt += 1) {
      const answer = await this.deps.catalogue.read();
      if (answer.designation?.batchId === batchId && answer.designation.profileName === input.profileName) {
        return { previousBatchId: answer.movingFrom?.batchId ?? null };
      }
      await this.refuseWorkingDesignation(answer.designation);
      const pinned = answer.pinned?.batchId ?? null;
      try {
        const saved = await this.deps.catalogue.designate(
          {
            expectedRevision: answer.revision,
            profileName: input.profileName,
            batchId,
            move: pinned !== null && pinned !== batchId,
          },
          purchaseActor(input.requestId),
        );
        return { previousBatchId: saved.movingFrom?.batchId ?? null };
      } catch (err) {
        // A refusal of the designation's own, CatalogueNodeInputError, carries its sentence as its message.
        if (err instanceof ManagerSettingsChangedError && attempt < REVISION_ATTEMPTS) continue;
        throw err;
      }
    }
  }

  /**
   * Refuses to move the catalogue off a designated batch that still works: the designation runs long after the
   * purchase was checked, an hour later or after a check days later, and a batch designated meanwhile by another hand
   * stays. One that expired, that its node holds no more, or none, is moved off.
   */
  private async refuseWorkingDesignation(designation: CatalogueNodeAnswer['designation']): Promise<void> {
    if (!designation) return;
    const holder = await this.deps.profiles.findByName(designation.profileName);
    const state = holder ? (await this.deps.stamps.stampHealthFor(holder, designation.batchId)).state : 'unknown';
    const problem = purchaseReplaceProblem('catalogue', state);
    if (problem) {
      throw new PurchaseFollowUpError(
        `The bought batch was not designated, because batch ${shortBatch(designation.batchId)} is the catalogue batch now. ${problem}`,
      );
    }
  }

  async release(input: { batchId: string; previousBatchId: string; requestId: string }): Promise<void> {
    const batchId = normalBatchId(input.batchId);
    const previousBatchId = normalBatchId(input.previousBatchId);
    for (let attempt = 1; ; attempt += 1) {
      const answer = await this.deps.catalogue.read();
      const pinned = answer.pinned?.batchId ?? null;
      if (pinned !== batchId) {
        throw new PurchaseFollowUpError(
          `The catalogue has moved on from batch ${shortBatch(batchId)} since, so batch ${shortBatch(previousBatchId)} is not released for this purchase.`,
        );
      }
      if (!answer.movingFrom) return;
      if (answer.movingFrom.batchId !== previousBatchId) {
        throw new PurchaseFollowUpError(
          `The catalogue is moving from batch ${shortBatch(answer.movingFrom.batchId)} now, not from batch ${shortBatch(previousBatchId)}, so nothing was released for this purchase.`,
        );
      }
      try {
        await this.deps.catalogue.release({ expectedRevision: answer.revision }, purchaseActor(input.requestId));
        return;
      } catch (err) {
        // A refusal of the designation's own, CatalogueNodeInputError, carries its sentence as its message.
        if (err instanceof ManagerSettingsChangedError && attempt < REVISION_ATTEMPTS) continue;
        throw err;
      }
    }
  }
}

async function profileNamed(deps: PurchaseFollowUpPortsDeps, name: string): Promise<Profile> {
  const profile = await deps.profiles.findByName(name);
  if (!profile) throw new PurchaseFollowUpError(`There is no deployment called ${name} on this manager.`);
  return profile;
}
