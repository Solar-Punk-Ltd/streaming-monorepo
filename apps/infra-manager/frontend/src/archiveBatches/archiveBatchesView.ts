import {
  type ArchiveBatchCandidate,
  type ArchiveBatchRow,
  archiveRemoveProblem,
  formatDateTime,
  formatTtl,
  shortHex,
} from '@streaming-infra-manager/common';

/**
 * What the Manager settings page's archive batches card says, and which batches it offers. The rules are the
 * manager's own: the candidates come with the sentence that refuses each, and a removal is checked again by the
 * manager against the batch's node.
 */

export const ARCHIVE_LEAD =
  'Immutable batches on the catalogue node that the web2 admin copies finished recordings onto, so a recording outlives the batches of the stage that made it. The admin buys them; a batch bought another way is adopted here.';
export const ARCHIVE_NONE = 'No archive batches yet.';
export const ARCHIVE_NO_CATALOGUE_NODE =
  'No catalogue node is designated, so no batch can be adopted. Designate the catalogue node above first.';
export const ARCHIVE_NO_CANDIDATES =
  'The catalogue node holds no other batch. Buy an immutable one on its Storage and funding card, or let the web2 admin buy one.';
export const ARCHIVE_ADOPTED = 'Archive batch adopted';
export const ARCHIVE_REMOVED = 'Archive batch removed';
export const ARCHIVE_SAVE_RACE =
  'Another change reached the archive batches after this page read them. They are shown as they stand now. Make the change again.';
export const ARCHIVE_REMOVE_TITLE = 'Remove the archive batch?';
export const ARCHIVE_REMOVE_CONFIRM = 'Remove';

/** One archive batch's first line: its label or its id, and the deployment whose node holds it. */
export function archiveBatchTitle(row: ArchiveBatchRow): string {
  const name = row.label ?? `Batch ${shortHex(row.batchId)}`;
  return `${name} on ${row.profileName}`;
}

/** How the batch became an archive batch, and when. */
export function archiveBatchOrigin(row: ArchiveBatchRow): string {
  const when = formatDateTime(row.designatedAt);
  if (row.source === 'purchase') return `Bought through the web2 admin ${when}`;
  return `Adopted ${when}${row.designatedBy ? ` by ${row.designatedBy}` : ''}`;
}

/** Whether the admin can copy recordings onto the batch now, and why not when it cannot. */
export function archiveBatchWritableLine(row: ArchiveBatchRow, catalogueProfileName: string | null): string {
  if (row.writable) return 'The web2 admin copies recordings onto it.';
  if (catalogueProfileName === null) return 'Nothing is copied onto it while no catalogue node is designated.';
  if (row.profileName !== catalogueProfileName) {
    return `${row.profileName} is the catalogue node no longer, so nothing more is copied onto it. It can still be topped up.`;
  }
  if (!row.reading) return 'Not read yet, so nothing is copied onto it until it is.';
  if (row.reading.state === 'pending') return 'Not usable yet, so nothing is copied onto it until it is.';
  if (row.reading.state === 'unknown') return 'Its node did not answer, so nothing is copied onto it until it does.';
  return 'Nothing more is copied onto it.';
}

/**
 * Why the card does not offer Remove for a batch, the manager's own sentence, or null when it does: for a batch whose
 * last reading says it expired or was dropped, and for one whose deployment is gone. The manager reads the batch
 * again before it takes it off.
 */
export function archiveBatchRemoveProblem(row: ArchiveBatchRow, deploymentGone: boolean): string | null {
  return archiveRemoveProblem(row.reading?.state ?? null, { deploymentGone });
}

/** What the removal's confirm says. */
export function archiveRemoveConfirmText(row: ArchiveBatchRow, deploymentGone: boolean): string {
  const batch = `batch ${shortHex(row.batchId)}`;
  if (deploymentGone) {
    return `Take ${batch} off the archive batches? Its deployment, ${row.profileName}, is gone, so no node can top it up. Its recordings stay on Swarm until the batch expires, and the web2 admin shows them as expired once it is off the list.`;
  }
  return `Take ${batch} on ${row.profileName} off the archive batches? The manager then stops listing it, pushing it to the web2 admin and funding it. It checks with the node first, and keeps a batch that has not expired.`;
}

/** One candidate as the adopt picker lists it: its label on the node, depth, life left and why it is refused. */
export function archiveCandidateLabel(candidate: ArchiveBatchCandidate): string {
  const name = candidate.nodeLabel ? `${candidate.nodeLabel} · ` : '';
  const depth = candidate.depth === null ? 'depth unknown' : `depth ${candidate.depth}`;
  const life =
    candidate.ttlSeconds === null || candidate.ttlSeconds < 0
      ? 'life left unknown'
      : candidate.ttlSeconds === 0
        ? 'no life left'
        : `${formatTtl(candidate.ttlSeconds)} left`;
  const kind = candidate.immutable === null ? 'kind unknown' : candidate.immutable ? 'immutable' : 'mutable';
  return `${name}${shortHex(candidate.batchId)} · ${depth} · ${life} · ${kind}`;
}
