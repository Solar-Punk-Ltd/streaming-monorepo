import {
  type BeePublisherEntry,
  beePublishersValue,
  getErrorMessage,
  hasBeePublishers,
  isLadderKind,
  parseBeePublishers,
  rungFromMemberName,
  rungOrder,
  stampStateReason,
} from '@streaming-infra-manager/common';

import type { DeploymentGroup, Profile } from '../../types/index.js';
import type { DeploymentGroupRepository } from '../DeploymentGroupRepository.js';
import { ProfileConfigError } from '../errors/index.js';
import type { LocalPublisherHostReader } from '../localHost.js';
import { Logger } from '../Logger.js';
import type { PoolStringGuard } from '../ProfileService.js';
import type { ProfileRepository } from '../ProfileRepository.js';
import { beePublisherUrlFor } from '../StampService.js';

const logger = Logger.getInstance();

export interface StagePoolStringsDeps {
  profiles: Pick<ProfileRepository, 'list' | 'updatePoolString'>;
  groups: Pick<DeploymentGroupRepository, 'list'>;
  /** What a container on this host reaches a node this manager deployed on, as the pool card's string names it. */
  publisherHost: LocalPublisherHostReader;
  guard?: PoolStringGuard;
  /** Told of a stage whose stored pool string was brought up to its pool's batches. */
  changed?: (profile: Profile) => Promise<void>;
}

interface PoolRung {
  rung: string;
  url: string;
  member: Profile;
}

interface StagePool {
  group: DeploymentGroup;
  rungs: PoolRung[];
}

/**
 * The pool string of an ABR stage, kept on the batches its pool holds now.
 *
 * A stage's pool is the ABR node pool on this manager whose rungs its entries
 * name: every entry is the address of that pool's member for the same rung. A
 * string that names any other node was not taken from a pool here and is left
 * as it was saved. A deploy renders the pool's current string, and a batch set
 * on a rung brings the stored copy of every stage of its pool up to date, so
 * the stage page and the rung report name the batches the next deploy pays
 * with. Docs: docs/features/abr-ladder.md.
 */
export class StagePoolStrings {
  constructor(private readonly deps: StagePoolStringsDeps) {}

  /**
   * The stage as its deploy writes it: with its pool's current string where it
   * has a pool, stored first when it differs. Refuses a pool string the stage
   * could not publish through, a rung with no batch or one the guard refuses.
   */
  async withCurrentBatches(stage: Profile): Promise<Profile> {
    const entries = entriesOf(stage);
    if (!entries) return stage;
    const pool = poolNamedBy(entries, await this.pools());
    if (!pool) return stage;

    const unstamped = pool.rungs.find((rung) => !rung.member.stamp_id);
    if (unstamped) {
      throw new ProfileConfigError(stage.name, `${unstamped.rung}: ${stampStateReason('none')}`);
    }
    const current = currentPoolString(pool);
    const problem = this.deps.guard ? await this.deps.guard(current) : null;
    if (problem) throw new ProfileConfigError(stage.name, problem);

    return (await this.store(stage, pool, current)) ?? { ...stage, bee_publishers: current };
  }

  /** Brings the stored copy of every stage of this rung's pool to the pool's batches. Never throws. */
  async refreshStagesOf(memberName: string): Promise<void> {
    try {
      const profiles = await this.deps.profiles.list();
      const pools = await this.pools(profiles);
      const pool = pools.find((candidate) => candidate.rungs.some((rung) => rung.member.name === memberName));
      if (!pool || pool.rungs.some((rung) => !rung.member.stamp_id)) return;
      const current = currentPoolString(pool);
      if (this.deps.guard && (await this.deps.guard(current))) return;
      for (const stage of profiles) {
        const entries = entriesOf(stage);
        if (entries && poolNamedBy(entries, [pool])) await this.store(stage, pool, current);
      }
    } catch (err) {
      logger.warn(
        `[StagePoolStrings] the stages of ${memberName}'s pool keep their stored pool string: ${getErrorMessage(err)}`,
      );
    }
  }

  private async store(stage: Profile, pool: StagePool, current: string): Promise<Profile | null> {
    if (stage.bee_publishers === current) return stage;
    const written = await this.deps.profiles.updatePoolString(stage.name, stage.bee_publishers ?? '', current);
    if (!written) return null;
    logger.info(`[StagePoolStrings] ${stage.name}: pool string now carries the batches of pool ${pool.group.name}`);
    await this.deps.changed?.(written);
    return written;
  }

  private async pools(profiles?: readonly Profile[]): Promise<StagePool[]> {
    const groups = (await this.deps.groups.list()).filter((group) => isLadderKind(group.kind));
    if (groups.length === 0) return [];
    const rows = profiles ?? (await this.deps.profiles.list());
    const host = await this.deps.publisherHost();
    return groups.map((group) => ({
      group,
      rungs: rows
        .filter((profile) => profile.group_id === group.id)
        .flatMap((member) => {
          const rung = rungFromMemberName(group.name, member.name);
          return rung ? [{ rung, url: beePublisherUrlFor(member, host), member }] : [];
        })
        .sort((a, b) => rungOrder(a.rung) - rungOrder(b.rung)),
    }));
  }
}

function entriesOf(profile: Profile): BeePublisherEntry[] | null {
  if (!hasBeePublishers(profile)) return null;
  return parseBeePublishers(profile.bee_publishers ?? '');
}

/** The pool every entry names a rung node of, or null. */
function poolNamedBy(entries: readonly BeePublisherEntry[], pools: readonly StagePool[]): StagePool | null {
  return (
    pools.find(
      (pool) =>
        entries.length === pool.rungs.length &&
        entries.every((entry) => pool.rungs.some((rung) => rung.rung === entry.rung && rung.url === entry.url)),
    ) ?? null
  );
}

function currentPoolString(pool: StagePool): string {
  return beePublishersValue(
    pool.rungs.map((rung) => ({ rungName: rung.rung, url: rung.url, batchId: rung.member.stamp_id!.toLowerCase() })),
  );
}
