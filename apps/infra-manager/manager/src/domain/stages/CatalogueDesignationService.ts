import {
  CATALOGUE_NOT_HELD_REFUSAL,
  CATALOGUE_SEGMENT_BATCH_REFUSAL,
  CATALOGUE_UNREACHABLE_REFUSAL,
  type CatalogueDesignation,
  type CatalogueNodeAnswer,
  type CatalogueNodeClear,
  type CatalogueNodeSave,
  type CataloguePushState,
  type CatalogueReading,
  catalogueBatchProblem,
  catalogueMoveRefusal,
  catalogueNodeProblem,
  parseBeePublishers,
} from '@streaming-infra-manager/common';

import type { Profile } from '../../types/index.js';
import type { BeeStamp } from '../BeeClient.js';
import { CatalogueNodeInputError, ManagerSettingsChangedError, StampNotFoundError } from '../errors/index.js';
import { Logger } from '../Logger.js';

import {
  type CatalogueDesignationRow,
  type CatalogueDesignationStore,
  isDesignated,
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
  status(): { reading: CatalogueReading | null; lastPush: CataloguePushState | null };
  /** Tells the catalogue publisher the designation changed, so it pushes or clears now. */
  changed(): void;
  /**
   * The addresses a pool string could name the catalogue node's Bee API by: the one the control host reaches it on,
   * and the one a container on this host does. Without it only the batch id is matched.
   */
  nodeUrls?(profile: Profile): Promise<string[]>;
  now?: () => number;
}

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

/**
 * The brand's catalogue node, which the Manager settings page designates: a Bee-only deployment of this manager and
 * one immutable batch its node holds, pinned by id. A designation is refused, with a sentence saying why, for a
 * deployment that is more than a Bee node or a rung of a node pool, and for a batch the node does not hold, one it
 * calls mutable, one whose kind it does not report, one that has expired, and one an ABR uploader stamps segments
 * with. A save and a clear name the revision they read, as the admin link's do.
 *
 * Once a batch has been designated it stays the catalogue's, through a clear as well: its slots are stamped by it,
 * so another batch is refused until moving the catalogue exists, and the same one can be designated again. The
 * deployment it was designated on is not removed.
 */
export class CatalogueDesignationService {
  private readonly now: () => number;

  constructor(private readonly deps: CatalogueDesignationDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async read(): Promise<CatalogueNodeAnswer> {
    return this.answerOf(await this.deps.store.read());
  }

  async designate(save: CatalogueNodeSave, username: string): Promise<CatalogueNodeAnswer> {
    const stored = await this.deps.store.read();
    if (stored.revision !== save.expectedRevision) throw new ManagerSettingsChangedError();
    if (!BATCH_ID_RE.test(save.batchId)) {
      throw new CatalogueNodeInputError(['batchId is a batch id, 64 hex digits with or without 0x.']);
    }
    const batchId = save.batchId.replace(/^0x/, '').toLowerCase();
    if (stored.batchId !== null && stored.batchId !== batchId) {
      throw new CatalogueNodeInputError([catalogueMoveRefusal(stored.batchId)]);
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

    const saved = await this.deps.store.designate(
      { profileName: profile.name, batchId, batchDepth: stamp.depth, at: new Date(this.now()) },
      save.expectedRevision,
      username,
    );
    if (!saved) throw new ManagerSettingsChangedError();
    logger.info(
      `[Catalogue] ${username} designated ${profile.name} as the catalogue node, batch ${batchId}, now at revision ${saved.revision}`,
    );
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
   * The deployment the catalogue is pinned to, designated or cleared since, or null before the first designation.
   * What the removal guard asks: the catalogue's slots are stamped by that node's batch either way.
   */
  async designatedNode(): Promise<string | null> {
    return (await this.deps.store.read()).profileName;
  }

  /**
   * Why a pool string cannot be stored, or null: an entry that names the catalogue's batch, or the catalogue node's
   * Bee API, would stamp a stream's segments into the batch the catalogue's slots live in. Asked by the profile
   * create and update paths, for the batch and node the catalogue is pinned to, cleared or not.
   */
  async segmentBatchProblem(beePublishers: string): Promise<string | null> {
    const entries = parseBeePublishers(beePublishers) ?? [];
    if (entries.length === 0) return null;
    const row = await this.deps.store.read();
    if (!row.profileName || !row.batchId) return null;
    if (entries.some((entry) => entry.batchId === row.batchId)) return CATALOGUE_SEGMENT_BATCH_REFUSAL;
    const profile = await this.deps.profiles.findByName(row.profileName);
    if (!profile || !this.deps.nodeUrls) return null;
    const nodeHosts = new Set((await this.deps.nodeUrls(profile)).map(hostOf));
    nodeHosts.delete(null);
    return entries.some((entry) => nodeHosts.has(hostOf(entry.url))) ? CATALOGUE_SEGMENT_BATCH_REFUSAL : null;
  }

  private answerOf(row: CatalogueDesignationRow): CatalogueNodeAnswer {
    const designation = designationOf(row);
    const { reading, lastPush } = this.deps.status();
    const current = designation && reading?.batchId === designation.batchId ? reading : null;
    const pinned = row.profileName && row.batchId ? { profileName: row.profileName, batchId: row.batchId } : null;
    return { designation, pinned, revision: row.revision, reading: current, lastPush };
  }
}
