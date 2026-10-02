import {
  type CatalogueNodeCandidate,
  type CatalogueReading,
  catalogueBatchProblem,
  catalogueNodeProblem,
  catalogueReleaseFirstRefusal,
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
/** What the card says while a designation is cleared: the batch the catalogue stays pinned to. */
export function cataloguePinnedNote(pinned: { profileName: string; batchId: string }): string {
  return `The catalogue stays pinned to batch ${shortHex(pinned.batchId)} on ${pinned.profileName}, which stamps its slots. Designate it again to write the catalogue once more; another batch is a move.`;
}

export const CATALOGUE_MOVED = 'Catalogue moved';
export const CATALOGUE_RELEASED = 'Previous batch released';
export const CATALOGUE_MOVE_TITLE = 'Move the catalogue?';
export const CATALOGUE_MOVE_CONFIRM = 'Move the catalogue';
export const CATALOGUE_RELEASE_LABEL = 'Release the previous batch';
export const CATALOGUE_RELEASE_TITLE = 'Release the previous batch?';
export const CATALOGUE_RELEASE_CONFIRM = 'Release';

/** The save button's label for a batch that moves the catalogue. */
export function catalogueMoveLabel(batchId: string): string {
  return `Move the catalogue to batch ${shortHex(batchId)}`;
}

/** What the confirm step says before a move: what the admin does, and what to keep alive until it is done. */
export function catalogueMoveConfirmText(fromBatchId: string, toBatchId: string): string {
  return `The web2 admin stamps every slot of the catalogue again under batch ${shortHex(toBatchId)}, then switches to it. Until the admin’s console says the move is done, keep batch ${shortHex(fromBatchId)} alive, then press ${CATALOGUE_RELEASE_LABEL} here.`;
}

/** The line that heads a pending move on the card. */
export function catalogueMovingLine(move: { profileName: string; batchId: string }): string {
  return `Moving from batch ${shortHex(move.batchId)} on ${move.profileName}`;
}

/** The steps of a pending move, in order, as the card lists them. */
export function catalogueMoveSteps(toBatchId: string): string[] {
  return [
    `In the web2 admin, on the Stages page, start “${catalogueMoveLabel(toBatchId)}”. It needs CATALOGUE_MOVE_ENABLED on that installation.`,
    'Wait until it says the move is done.',
    `Press “${CATALOGUE_RELEASE_LABEL}” here.`,
  ];
}

/** What the confirm step says before a release: what it lets go of, and when to press it. */
export function catalogueReleaseConfirmText(move: { profileName: string; batchId: string }): string {
  return `The manager stops keeping batch ${shortHex(move.batchId)} for the catalogue: ${move.profileName} can then be removed, and the batch may lapse. Press it only once the web2 admin reports the move done.`;
}

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

/**
 * One batch the card offers: its reading in a line, why it cannot be the catalogue's when it cannot, and whether
 * choosing it moves the catalogue off the pinned batch.
 */
export interface CatalogueBatchView {
  batchId: string;
  label: string;
  problem: string | null;
  move: boolean;
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

/**
 * The batches the card offers, each refused as the manager refuses it. Once a batch has been designated, another one
 * is a move, which the card confirms before it saves. While a move is pending only the batch moved from can be moved
 * to, back, and every third one is refused until that batch is released.
 */
export function catalogueBatchViews(
  stamps: readonly CatalogueBatchStamp[],
  pinnedBatchId: string | null = null,
  movingFromBatchId: string | null = null,
): CatalogueBatchView[] {
  return stamps.map((stamp) => {
    const batchId = stamp.batchID.replace(/^0x/, '').toLowerCase();
    const move = pinnedBatchId !== null && batchId !== pinnedBatchId;
    const thirdBatch = move && movingFromBatchId !== null && batchId !== movingFromBatchId;
    return {
      batchId,
      label: `${shortHex(stamp.batchID)} · depth ${stamp.depth} · ${formatTtl(stamp.batchTTL)} · ${fillOf(fullestBucketFillRatio(stamp))} · ${kindOf(stamp.immutableFlag)}`,
      problem: thirdBatch ? catalogueReleaseFirstRefusal(movingFromBatchId) : catalogueBatchProblem(stamp),
      move: move && !thirdBatch,
    };
  });
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

/**
 * What the card says when Docker reports the pinned node's Bee API published on every address of its host. The API
 * asks for no password, and the catalogue's batch is behind it.
 */
export const CATALOGUE_API_EVERY_ADDRESS_WARNING =
  'Docker publishes this node’s Bee API on every address of its host, and the API asks for no password: whoever reaches the port can spend the node’s funds or fill the catalogue’s batch. On the manager’s own host a redeploy binds it to the Docker bridge where the manager confirmed the bridge, and the manager’s log says where it could not; there, set BEE_UPLOADER_API_BIND in the node’s settings, or BEE_UPLOADER_API_LISTEN under host networking. On another host, its firewall must admit the control host alone.';

/** The warning about the pinned node's Bee API, or null when Docker reports it bound to one address or was not read. */
export function catalogueApiWarning(answer: { apiOnEveryAddress?: boolean | null }): string | null {
  return answer.apiOnEveryAddress === true ? CATALOGUE_API_EVERY_ADDRESS_WARNING : null;
}

/** What the deployment page says on the catalogue node's Storage and funding card. */
export function pinnedBatchNote(batchId: string): string {
  return `This node is the brand’s catalogue node, and batch ${shortHex(batchId)} is pinned for the catalogue. Buying a batch here, or using another one, changes the batch this deployment records and leaves the catalogue on the pinned one. Moving the catalogue to another batch is its own action. Top up the pinned batch here to keep it alive.`;
}
