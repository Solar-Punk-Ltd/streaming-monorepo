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
  catalogueNodeProblem,
  parseBeePublishers,
} from '@streaming-infra-manager/common';

import type { Profile } from '../../types/index.js';
import type { BeeStamp } from '../BeeClient.js';
import { CatalogueNodeInputError, ManagerSettingsChangedError, StampNotFoundError } from '../errors/index.js';
import { Logger } from '../Logger.js';

import type { CatalogueDesignationRow, CatalogueDesignationStore } from './CatalogueDesignationRepository.js';

const logger = Logger.getInstance();

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
  now?: () => number;
}

/** The designation a row holds, or null when it holds none. */
export function designationOf(row: CatalogueDesignationRow): CatalogueDesignation | null {
  if (!row.profileName || !row.batchId || !row.designatedAt) return null;
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
    if (!designationOf(stored)) throw new CatalogueNodeInputError(['No catalogue node is designated.']);
    const saved = await this.deps.store.clear(new Date(this.now()), clear.expectedRevision, username);
    if (!saved) throw new ManagerSettingsChangedError();
    logger.info(`[Catalogue] ${username} cleared the catalogue node, now at revision ${saved.revision}`);
    this.deps.changed();
    return this.answerOf(saved);
  }

  /** The deployment the catalogue is designated on, or null. What the removal guard asks. */
  async designatedNode(): Promise<string | null> {
    return (await this.deps.store.read()).profileName;
  }

  private answerOf(row: CatalogueDesignationRow): CatalogueNodeAnswer {
    const designation = designationOf(row);
    const { reading, lastPush } = this.deps.status();
    const current = designation && reading?.batchId === designation.batchId ? reading : null;
    return { designation, revision: row.revision, reading: current, lastPush };
  }
}
