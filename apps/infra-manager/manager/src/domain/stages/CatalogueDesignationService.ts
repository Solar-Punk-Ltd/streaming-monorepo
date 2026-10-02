import {
  CATALOGUE_NO_MOVE_REFUSAL,
  CATALOGUE_NOT_HELD_REFUSAL,
  CATALOGUE_SEGMENT_BATCH_REFUSAL,
  CATALOGUE_UNREACHABLE_REFUSAL,
  type CatalogueDesignation,
  type CatalogueMove,
  type CatalogueNodeAnswer,
  type CatalogueNodeClear,
  type CatalogueNodeRelease,
  type CatalogueNodeSave,
  type CataloguePushState,
  type CatalogueReading,
  catalogueBatchProblem,
  catalogueMoveRefusal,
  catalogueNodeProblem,
  catalogueReleaseFirstRefusal,
  catalogueShallowBatchRefusal,
  getErrorMessage,
  MIN_CATALOGUE_DEPTH,
  parseBeePublishers,
  shortHex,
} from '@streaming-infra-manager/common';

import type { Profile } from '../../types/index.js';
import type { BeeStamp } from '../BeeClient.js';
import {
  CatalogueNodeInputError,
  CatalogueNodeRemovalError,
  ManagerSettingsChangedError,
  StampNotFoundError,
} from '../errors/index.js';
import { Logger } from '../Logger.js';

import {
  type CatalogueDesignationRow,
  type CatalogueDesignationStore,
  isDesignated,
  isMoving,
} from './CatalogueDesignationRepository.js';

const logger = Logger.getInstance();

/** A Bee API address's host and port, in lower case, or null for one that is not an address. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** A batch id as Bee prints one, with or without `0x`. */
const BATCH_ID_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/** What the catalogue publisher last read and sent, for the answer. */
export interface CatalogueStatus {
  /** The last reading of the pinned batch. */
  reading: CatalogueReading | null;
  /** The last reading of the batch the catalogue is moving from, while a move is pending. */
  previousReading: CatalogueReading | null;
  lastPush: CataloguePushState | null;
}

export interface CatalogueDesignationDeps {
  store: CatalogueDesignationStore;
  profiles: {
    findByName(name: string): Promise<Profile | null>;
    list(): Promise<Profile[]>;
  };
  /** The kind of a deployment group, or null for none. */
  groupKindOf(groupId: number): Promise<string | null>;
  /** One batch as the deployment's node reports it now, `StampService.heldBatch`. */
  heldBatch(name: string, batchId: string): Promise<BeeStamp>;
  /** What the catalogue publisher last read and sent, for the answer. */
  status(): CatalogueStatus;
  /** Tells the catalogue publisher the designation changed, so it pushes or clears now. */
  changed(): void;
  /**
   * The addresses a pool string could name the catalogue node's Bee API by: the one the control host reaches it on,
   * and the one a container on this host does. Without it only the batch id is matched.
   */
  nodeUrls?(profile: Profile): Promise<string[]>;
  /**
   * Whether Docker publishes the deployment's Bee API on every address of its host (`beeApiOnEveryAddress`), read on
   * its daemon, local or over ssh. Without it the answer says null.
   */
  apiOnEveryAddress?(profile: Profile): Promise<boolean | null>;
  now?: () => number;
}

/** How long a reading of the pinned node's API binding stands: the card asks every ten seconds, ssh is slower. */
const API_BINDING_READ_MS = 60_000;

/** The designation a row holds in force, or null when it holds none or it was cleared. */
export function designationOf(row: CatalogueDesignationRow): CatalogueDesignation | null {
  if (!isDesignated(row)) return null;
  return {
    profileName: row.profileName,
    batchId: row.batchId,
    designatedAt: row.designatedAt.toISOString(),
    designatedBy: row.designatedBy,
  };
}

/** The pending move a row holds, with the last reading of the batch moved from, or null with none pending. */
function moveOf(row: CatalogueDesignationRow, reading: CatalogueReading | null): CatalogueMove | null {
  if (!isMoving(row)) return null;
  return {
    profileName: row.movingFromProfileName,
    batchId: row.movingFromBatchId,
    startedAt: row.moveStartedAt.toISOString(),
    startedBy: row.moveStartedBy,
    reading: reading?.batchId === row.movingFromBatchId ? reading : null,
  };
}

/**
 * The brand's catalogue node, which the Manager settings page designates: a Bee-only deployment of this manager and
 * one immutable batch its node holds, pinned by id. A designation is refused, with a sentence saying why, for a
 * deployment that is more than a Bee node or a rung of a node pool, and for a batch the node does not hold, one it
 * calls mutable, one whose kind it does not report, one that has expired, one an ABR uploader stamps segments
 * with, and a new one shallower than `MIN_CATALOGUE_DEPTH`. A save, a clear and a release name the revision they
 * read, as the admin link's do.
 *
 * Once a batch has been designated it stays the catalogue's, through a clear as well: its slots are stamped by it, so
 * another batch is a move, saved only when the page confirms it as one, and the same batch can be designated again.
 * A move pins the new batch and records the one it moved off, which holds the catalogue's history until the web2
 * admin has stamped every slot again under the new one. While it is pending, a third batch is refused, and moving
 * back to the batch moved from swaps the two. A release takes the batch moved from out, once the admin reports the
 * move done. The deployments of the pinned batch and of the batch moved from are not removed, and no pool string may
 * name either.
 *
 * The manager keeps no audit table: each change is logged with the user who made it, and the row records who and
 * when.
 */
export class CatalogueDesignationService {
  private readonly now: () => number;
  /** The last reading of the pinned node's API binding, by deployment and when it was read. */
  private apiBinding: { profileName: string; onEveryAddress: boolean | null; at: number } | null = null;
  /** The reading under way, at most one: a GET answers the last one meanwhile. */
  private apiBindingRead: Promise<void> | null = null;
  /** The deployments whose failed reading has been logged as a warning, after which a failure is logged at debug. */
  private readonly apiBindingWarned = new Set<string>();

  constructor(private readonly deps: CatalogueDesignationDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async read(): Promise<CatalogueNodeAnswer> {
    const row = await this.deps.store.read();
    this.refreshApiBinding(row.profileName);
    return this.answerOf(row);
  }

  /**
   * Starts reading the pinned node's API binding again once the last reading is a minute old, in the background: a
   * node on an unreachable host holds ssh for seconds, and the card asks every ten. At most one reading runs at a time.
   */
  private refreshApiBinding(profileName: string | null): void {
    if (!profileName || !this.deps.apiOnEveryAddress || this.apiBindingRead) return;
    const at = this.now();
    const last = this.apiBinding;
    if (last && last.profileName === profileName && at - last.at < API_BINDING_READ_MS) return;
    this.apiBindingRead = this.readApiBinding(profileName, at).finally(() => {
      this.apiBindingRead = null;
    });
  }

  /**
   * One reading, which never throws. A failure answers null, and is a warning the first time for a deployment, since
   * the card then shows nothing about an API that may be open, and a debug line after.
   */
  private async readApiBinding(profileName: string, at: number): Promise<void> {
    let onEveryAddress: boolean | null = null;
    try {
      const profile = await this.deps.profiles.findByName(profileName);
      onEveryAddress = profile && this.deps.apiOnEveryAddress ? await this.deps.apiOnEveryAddress(profile) : null;
    } catch (err) {
      const message = `[Catalogue] could not read how ${profileName}'s Bee API is published, so the card cannot say whether it answers on every address: ${getErrorMessage(err)}`;
      if (this.apiBindingWarned.has(profileName)) logger.debug(message);
      else {
        this.apiBindingWarned.add(profileName);
        logger.warn(message);
      }
    }
    this.apiBinding = { profileName, onEveryAddress, at };
  }

  async designate(save: CatalogueNodeSave, username: string): Promise<CatalogueNodeAnswer> {
    const stored = await this.deps.store.read();
    if (stored.revision !== save.expectedRevision) throw new ManagerSettingsChangedError();
    if (!BATCH_ID_RE.test(save.batchId)) {
      throw new CatalogueNodeInputError(['batchId is a batch id, 64 hex digits with or without 0x.']);
    }
    const batchId = save.batchId.replace(/^0x/, '').toLowerCase();
    // Another batch than the pinned one is a move: only the one moved from while a move is pending, and only confirmed.
    const pinnedBatchId = stored.batchId;
    const moving = pinnedBatchId !== null && pinnedBatchId !== batchId;
    if (moving && stored.movingFromBatchId !== null && stored.movingFromBatchId !== batchId) {
      throw new CatalogueNodeInputError([catalogueReleaseFirstRefusal(stored.movingFromBatchId)]);
    }
    if (moving && save.move !== true) {
      throw new CatalogueNodeInputError([catalogueMoveRefusal(pinnedBatchId, batchId)]);
    }

    const profile = await this.deps.profiles.findByName(save.profileName);
    if (!profile) throw new CatalogueNodeInputError([`There is no deployment called ${save.profileName}.`]);
    const groupKind = profile.group_id === null ? null : await this.deps.groupKindOf(profile.group_id);
    const nodeProblem = catalogueNodeProblem(profile, groupKind);
    if (nodeProblem) throw new CatalogueNodeInputError([nodeProblem]);

    const others = await this.deps.profiles.list();
    const stampsSegments = others.some((other) =>
      (parseBeePublishers(other.bee_publishers ?? '') ?? []).some((entry) => entry.batchId === batchId),
    );
    if (stampsSegments) throw new CatalogueNodeInputError([CATALOGUE_SEGMENT_BATCH_REFUSAL]);

    let stamp: BeeStamp;
    try {
      stamp = await this.deps.heldBatch(profile.name, batchId);
    } catch (err) {
      throw new CatalogueNodeInputError([
        err instanceof StampNotFoundError ? CATALOGUE_NOT_HELD_REFUSAL : CATALOGUE_UNREACHABLE_REFUSAL,
      ]);
    }
    const batchProblem = catalogueBatchProblem(stamp);
    if (batchProblem) throw new CatalogueNodeInputError([batchProblem]);
    if (!Number.isInteger(stamp.depth) || stamp.depth < 17 || stamp.depth > 64) {
      throw new CatalogueNodeInputError(['The node reported no depth for this batch that a batch can have.']);
    }
    // The minimum holds a new batch alone: the pinned one, designated again, and the one a move goes back to were
    // designated before it, and their slots are already stamped there.
    const known = batchId === pinnedBatchId || batchId === stored.movingFromBatchId;
    if (!known && stamp.depth < MIN_CATALOGUE_DEPTH) {
      throw new CatalogueNodeInputError([catalogueShallowBatchRefusal(stamp.depth)]);
    }

    const write = { profileName: profile.name, batchId, batchDepth: stamp.depth, at: new Date(this.now()) };
    const saved = moving
      ? await this.deps.store.move(write, save.expectedRevision, username)
      : await this.deps.store.designate(write, save.expectedRevision, username);
    if (!saved) throw new ManagerSettingsChangedError();
    if (moving) {
      const back = stored.movingFromBatchId === batchId ? ' back' : '';
      logger.info(
        `[Catalogue] ${username} moved the catalogue${back} from batch ${shortHex(pinnedBatchId)} on ${stored.profileName} to batch ${shortHex(batchId)} on ${profile.name}, now at revision ${saved.revision}`,
      );
    } else {
      logger.info(
        `[Catalogue] ${username} designated ${profile.name} as the catalogue node, batch ${batchId}, now at revision ${saved.revision}`,
      );
    }
    this.deps.changed();
    return this.answerOf(saved);
  }

  async clear(clear: CatalogueNodeClear, username: string): Promise<CatalogueNodeAnswer> {
    const stored = await this.deps.store.read();
    if (stored.revision !== clear.expectedRevision) throw new ManagerSettingsChangedError();
    if (!isDesignated(stored)) throw new CatalogueNodeInputError(['No catalogue node is designated.']);
    const saved = await this.deps.store.clear(new Date(this.now()), clear.expectedRevision, username);
    if (!saved) throw new ManagerSettingsChangedError();
    logger.info(`[Catalogue] ${username} cleared the catalogue node, now at revision ${saved.revision}`);
    this.deps.changed();
    return this.answerOf(saved);
  }

  /**
   * Takes the batch the catalogue moved from out of the row, which lifts the guards on it and its node: what the
   * operator does once the web2 admin reports the move done. Refused with no move pending.
   */
  async release(release: CatalogueNodeRelease, username: string): Promise<CatalogueNodeAnswer> {
    const stored = await this.deps.store.read();
    if (stored.revision !== release.expectedRevision) throw new ManagerSettingsChangedError();
    if (!isMoving(stored)) throw new CatalogueNodeInputError([CATALOGUE_NO_MOVE_REFUSAL]);
    const saved = await this.deps.store.release(new Date(this.now()), release.expectedRevision, username);
    if (!saved) throw new ManagerSettingsChangedError();
    logger.info(
      `[Catalogue] ${username} released batch ${shortHex(stored.movingFromBatchId)} on ${stored.movingFromProfileName} after the move to ${shortHex(stored.batchId ?? '')}`,
    );
    this.deps.changed();
    return this.answerOf(saved);
  }

  /**
   * The deployments the removal guard keeps: the one the catalogue is pinned to, designated or cleared since, and the
   * one of the batch it is moving from while a move is pending. Empty before the first designation.
   */
  async guardedNodes(): Promise<string[]> {
    const row = await this.deps.store.read();
    const names = [row.profileName, row.movingFromProfileName].filter((name): name is string => name !== null);
    return [...new Set(names)];
  }

  /** The removal guard: refuses to remove a deployment `guardedNodes` names, saying which batch keeps it. */
  async assertRemovable(name: string): Promise<void> {
    const row = await this.deps.store.read();
    if (row.profileName === name) throw new CatalogueNodeRemovalError(name);
    if (row.movingFromProfileName === name) throw new CatalogueNodeRemovalError(name, true);
  }

  /**
   * Why a pool string cannot be stored, or null: an entry that names the catalogue's batch, or the catalogue node's
   * Bee API, would stamp a stream's segments into the batch the catalogue's slots live in. Asked by the profile
   * create and update paths, for the batch and node the catalogue is pinned to, cleared or not, and for the batch
   * and node it is moving from while a move is pending.
   */
  async segmentBatchProblem(beePublishers: string): Promise<string | null> {
    const entries = parseBeePublishers(beePublishers) ?? [];
    if (entries.length === 0) return null;
    const row = await this.deps.store.read();
    const batches = new Set([row.batchId, row.movingFromBatchId].filter((id): id is string => id !== null));
    if (batches.size === 0) return null;
    if (entries.some((entry) => batches.has(entry.batchId))) return CATALOGUE_SEGMENT_BATCH_REFUSAL;
    if (!this.deps.nodeUrls) return null;
    const nodeHosts = new Set<string | null>();
    for (const name of await this.guardedNodes()) {
      const profile = await this.deps.profiles.findByName(name);
      if (profile) for (const url of await this.deps.nodeUrls(profile)) nodeHosts.add(hostOf(url));
    }
    nodeHosts.delete(null);
    return entries.some((entry) => nodeHosts.has(hostOf(entry.url))) ? CATALOGUE_SEGMENT_BATCH_REFUSAL : null;
  }

  private answerOf(row: CatalogueDesignationRow): CatalogueNodeAnswer {
    const designation = designationOf(row);
    const { reading, previousReading, lastPush } = this.deps.status();
    const current = designation && reading?.batchId === designation.batchId ? reading : null;
    const pinned = row.profileName && row.batchId ? { profileName: row.profileName, batchId: row.batchId } : null;
    const lastRelease = row.releasedAt ? { at: row.releasedAt.toISOString(), by: row.releasedBy } : null;
    return {
      designation,
      pinned,
      movingFrom: moveOf(row, previousReading),
      lastRelease,
      revision: row.revision,
      reading: current,
      lastPush,
      apiOnEveryAddress:
        row.profileName && this.apiBinding?.profileName === row.profileName ? this.apiBinding.onEveryAddress : null,
    };
  }
}
