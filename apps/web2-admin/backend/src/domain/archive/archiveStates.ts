import { archiveEffectiveChunks, type CatalogueArchiveBatch } from '@streaming-monorepo/contracts';
import {
  ARCHIVED_STATES,
  streamArchiveState,
  type ArchiveStamp,
  type QualityArchiveState,
  type StreamArchiveSummary,
} from '@streaming-monorepo/web2-admin-common';

import type { StreamRenditionRow, StreamRow } from '../../types/index.js';
import { expiredByClock } from '../stampAge.js';

import type { StreamArchiveRow } from './ArchiveRepository.js';

/**
 * What a stream and each of its qualities show of their archive, worked out from the copies the admin recorded, the
 * qualities' current playlist slots, and the archive stamps the manager last pushed. Pure, so the stream list, the
 * panel and the Archive page say the same. `docs/architecture/web2-admin.md`, "What a stream shows".
 */

/** What `rendition` holds for a recording with one quality, which has no rung of its own, as the export names it. */
export const SOURCE_RENDITION = 'source';

/**
 * The archive stamps as the admin holds them: the catalogue stamp record's `archiveBatches`, with the moment the
 * manager read them, or null when the admin was not told: no record has arrived, or it comes from a manager older than
 * the field.
 */
export interface ArchiveStampsHeld {
  batches: readonly CatalogueArchiveBatch[];
  observedAt: string;
}

/**
 * Where the copy's stamp stands: `expired` when it is expired or gone by its reading or by its time to live,
 * `unlisted` when the manager lists it no longer, so nothing says when it runs out, and `listed` otherwise, or when the
 * admin was not told.
 */
export function stampStanding(
  batchId: string,
  held: ArchiveStampsHeld | null,
  now: number,
): 'listed' | 'unlisted' | 'expired' {
  if (held === null) return 'listed';
  const batch = held.batches.find((candidate) => candidate.batchId === batchId);
  if (!batch) return 'unlisted';
  if (batch.state === 'expired' || batch.state === 'gone') return 'expired';
  return expiredByClock({ ttlSeconds: batch.ttlSeconds, observedAt: held.observedAt }, now) ? 'expired' : 'listed';
}

/** One quality's state from its copy, the slot it records now, and the stamps. */
export function qualityState(
  copy: StreamArchiveRow | undefined,
  currentIndex: number | null,
  held: ArchiveStampsHeld | null,
  now: number,
): QualityArchiveState {
  if (!copy) return 'none';
  if (copy.state === 'partial') return 'partial';
  const standing = stampStanding(copy.batch_id, held, now);
  if (standing === 'expired') return 'expired';
  if (currentIndex !== null && copy.manifest_index !== currentIndex) return 'outdated';
  if (standing === 'unlisted') return 'unlisted';
  return copy.parity_missing > 0 ? 'reduced' : 'complete';
}

/** The slot each quality of a stream records now: each rung's, or the stream's own for a single-quality recording. */
export function currentIndexes(stream: StreamRow, rungs: readonly StreamRenditionRow[]): Map<string, number | null> {
  if (rungs.length === 0) return new Map([[SOURCE_RENDITION, stream.manifest_index]]);
  return new Map(rungs.map((rung) => [rung.name, rung.manifest_index]));
}

/** The stream's archive for the stream list and its own answer; undefined when nothing of it was copied. */
export function streamArchiveSummary(
  stream: Pick<StreamRow, 'archived_only'>,
  copies: readonly StreamArchiveRow[],
  indexes: ReadonlyMap<string, number | null>,
  held: ArchiveStampsHeld | null,
  now: number,
): StreamArchiveSummary | undefined {
  if (copies.length === 0) return undefined;
  const states = copies.map((copy) => ({
    rendition: copy.rendition,
    state: qualityState(copy, indexes.get(copy.rendition) ?? null, held, now),
  }));
  return {
    state: streamArchiveState(states.map((entry) => entry.state)),
    archived: states.filter((entry) => ARCHIVED_STATES.includes(entry.state)).map((entry) => entry.rendition),
    archivedOnly: stream.archived_only,
  };
}

/** The names of the qualities that play from an archive stamp now: what the switch lists when there is any. */
export function archivedRenditions(
  copies: readonly StreamArchiveRow[],
  indexes: ReadonlyMap<string, number | null>,
  held: ArchiveStampsHeld | null,
  now: number,
): Set<string> {
  return new Set(
    copies
      .filter((copy) => ARCHIVED_STATES.includes(qualityState(copy, indexes.get(copy.rendition) ?? null, held, now)))
      .map((copy) => copy.rendition),
  );
}

/**
 * One archive stamp as the console shows it: its readings aged to now, what it holds and what is left of it, and the
 * node that holds it as the manager's inventory names it, when the inventory was read.
 */
export function toArchiveStamp(
  batch: CatalogueArchiveBatch,
  observedAt: string,
  chunksStamped: number | null,
  qualitiesArchived: number,
  ttlWarningDays: number,
  now: number,
  holder: { nodeId: string; nodeLabel: string } | null = null,
): ArchiveStamp {
  const effectiveChunks = archiveEffectiveChunks(batch.depth);
  const observed = Date.parse(observedAt);
  const elapsed = Number.isFinite(observed) ? Math.max(0, Math.floor((now - observed) / 1000)) : 0;
  const ttlSeconds = batch.ttlSeconds === null ? null : Math.max(0, batch.ttlSeconds - elapsed);
  return {
    batchId: batch.batchId,
    label: batch.label,
    nodeId: holder?.nodeId ?? null,
    nodeLabel: holder?.nodeLabel ?? null,
    depth: batch.depth,
    immutable: batch.immutable,
    state: batch.state,
    ttlSeconds,
    fillRatio: batch.fillRatio,
    writable: batch.writable,
    designatedAt: batch.designatedAt,
    effectiveChunks,
    chunksStamped,
    roomChunks: chunksStamped === null ? null : Math.max(0, effectiveChunks - chunksStamped),
    qualitiesArchived,
    expiresSoon: ttlSeconds !== null && ttlSeconds < ttlWarningDays * 86_400,
  };
}

/**
 * Why a copy cannot be written onto this stamp now, or null: listed writable, immutable, and not run out. The state the
 * manager read comes first, since the manager calls a stamp not writable in every state but `active` and `full`; only a
 * stamp read as one of those and still not writable sits on a node that is the catalogue node no longer.
 */
export function stampProblem(batch: CatalogueArchiveBatch | undefined, observedAt: string, now: number): string | null {
  if (!batch) return 'The archive stamp is no longer listed by the manager.';
  if (batch.state === 'pending') return 'The archive stamp is not usable yet.';
  if (batch.state === 'expired' || batch.state === 'gone') return `The archive stamp is ${batch.state}.`;
  if (batch.state === 'unknown' || batch.state === 'none') {
    return 'The manager could not read the archive stamp from its node.';
  }
  if (!batch.writable) {
    return 'The archive stamp is on a node that is the catalogue node no longer, so it can be topped up and never written.';
  }
  if (!batch.immutable) {
    return 'The archive stamp is mutable, and a mutable batch overwrites its oldest chunks once it fills.';
  }
  if (batch.state === 'full') return 'The archive stamp is full. Dilute it on the Stamps tab to give it room.';
  if (expiredByClock({ ttlSeconds: batch.ttlSeconds, observedAt }, now)) return 'The archive stamp has expired.';
  return null;
}

/**
 * What a copy is expected to cost the catalogue node's chequebook, in PLUR per chunk, from what step 0 measured on a
 * light node with about 90 peers (`docs/architecture/web2-admin.md`, "What it costs"): about 0.5 BZZ for a 1080p hour
 * of about 660,000 chunks when the recording is on the node and the free time allowance covers most of the push, and
 * 300,000 accounting units to read plus 388,000 to push a chunk, at 100,000 PLUR a unit, when nothing is covered.
 */
export const ARCHIVE_COST_LOW_PLUR_PER_CHUNK = 7_500_000_000n;
export const ARCHIVE_COST_HIGH_PLUR_PER_CHUNK = 68_800_000_000n;

export function bzzEstimate(chunks: number): { lowPlur: string; highPlur: string } {
  const count = BigInt(Math.max(0, Math.ceil(chunks)));
  return {
    lowPlur: (count * ARCHIVE_COST_LOW_PLUR_PER_CHUNK).toString(),
    highPlur: (count * ARCHIVE_COST_HIGH_PLUR_PER_CHUNK).toString(),
  };
}
