import {
  type CatalogueNodeCandidate,
  type CatalogueReading,
  catalogueBatchProblem,
  catalogueNodeProblem,
  formatFillPercent,
  formatTtl,
  fullestBucketFillRatio,
  isBeeNodeOnly,
  shortHex,
} from '@streaming-infra-manager/common';

/**
 * What the Manager settings page's catalogue node card says, and which deployments and batches it offers. The rules
 * are the manager's own, from the common package, so the card refuses what a save would be refused for, with the same
 * sentence.
 */

export const CATALOGUE_LEAD =
  'The Bee-only deployment the web2 admin writes the brand’s catalogue through, and the immutable batch pinned for it. The manager sends both to the admin its link names, and the admin writes with them.';
export const CATALOGUE_NONE = 'No catalogue node is designated, so the web2 admin cannot publish.';
export const CATALOGUE_NO_CANDIDATES =
  'This manager runs no deployment that is nothing but a Bee node. Create one, buy it an immutable batch, and designate it here.';
export const CATALOGUE_SAVED = 'Catalogue node saved';
export const CATALOGUE_CLEARED = 'Catalogue node cleared';
export const CATALOGUE_SAVE_RACE =
  'Another save changed the catalogue node after this page read it. It is shown as it stands now. Make the change again.';
export const CATALOGUE_MOVE_NOTE =
  'Designating another batch does not move what the catalogue has written so far. The web2 admin keeps writing with the batch it has history under, and says a move is waiting.';

/** One deployment the card offers, and why it cannot be the catalogue node when it cannot. */
export interface CatalogueCandidateView {
  name: string;
  problem: string | null;
}

/**
 * The deployments that are nothing but a Bee node, which are the ones the card lists, each with the reason it is
 * refused where it is: a rung of a node pool, or one being removed.
 */
export function catalogueCandidates(
  profiles: readonly (CatalogueNodeCandidate & { group_id?: number | null })[],
  groups: readonly { id: number; kind: string }[],
): CatalogueCandidateView[] {
  return profiles
    .filter((profile) => isBeeNodeOnly(profile))
    .map((profile) => {
      const kind = groups.find((group) => group.id === profile.group_id)?.kind ?? null;
      return { name: profile.name, problem: catalogueNodeProblem(profile, kind) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The fields of a node's batch the card reads, as the Storage listing answers it. */
export interface CatalogueBatchStamp {
  batchID: string;
  depth: number;
  bucketDepth: number;
  utilization: number;
  batchTTL: number;
  usable: boolean;
  exists?: boolean;
  immutableFlag?: boolean | null;
}

/** One batch the card offers: its reading in a line, and why it cannot be the catalogue's when it cannot. */
export interface CatalogueBatchView {
  batchId: string;
  label: string;
  problem: string | null;
}

/** A batch's kind as the node reported it, or that it did not. */
function kindOf(immutable: boolean | null | undefined): string {
  if (immutable === true) return 'immutable';
  if (immutable === false) return 'mutable';
  return 'kind not reported';
}

/** A fill as the card prints it, or a dash when the node did not say enough. */
function fillOf(fillRatio: number | null): string {
  return fillRatio === null ? 'fill unknown' : `${formatFillPercent(fillRatio)} full`;
}

export function catalogueBatchViews(stamps: readonly CatalogueBatchStamp[]): CatalogueBatchView[] {
  return stamps.map((stamp) => ({
    batchId: stamp.batchID.replace(/^0x/, '').toLowerCase(),
    label: `${shortHex(stamp.batchID)} · depth ${stamp.depth} · ${formatTtl(stamp.batchTTL)} · ${fillOf(fullestBucketFillRatio(stamp))} · ${kindOf(stamp.immutableFlag)}`,
    problem: catalogueBatchProblem(stamp),
  }));
}

/** The pinned batch's last reading in a line: its state, depth, life left and fill. */
export function catalogueReadingLine(reading: CatalogueReading | null): string {
  if (!reading) return 'The batch has not been read yet.';
  const depth = reading.depth === null ? 'depth unknown' : `depth ${reading.depth}`;
  const ttl =
    reading.ttlSeconds === null || reading.ttlSeconds < 0
      ? 'life left unknown'
      : reading.ttlSeconds === 0
        ? 'no life left'
        : `${formatTtl(reading.ttlSeconds)} left`;
  return `${reading.state} · ${depth} · ${ttl} · ${fillOf(reading.fillRatio)} · ${kindOf(reading.immutable)}`;
}

/** What the deployment page says on the catalogue node's Storage and funding card. */
export function pinnedBatchNote(batchId: string): string {
  return `This node is the brand’s catalogue node, and batch ${shortHex(batchId)} is pinned for the catalogue. Buying a batch here, or using another one, changes the batch this deployment records and leaves the catalogue on the pinned one. Moving the catalogue to another batch is its own action. Top up the pinned batch here to keep it alive.`;
}
