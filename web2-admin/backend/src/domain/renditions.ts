import type { Rendition } from '@streaming-monorepo/web2-admin-common';

import type { StreamRenditionRow } from '../types/index.js';

/**
 * The ABR ladder's vocabulary: what a stored rung looks like on the wire, how
 * a fresh report is merged into the one already stored, and when the ladder as
 * a whole counts as finished.
 *
 * The merge is the part with history behind it. It is `keepingWhatFinished` from
 * swarm-hls-stream's StreamCatalog, moved here because in admin mode the
 * uploader no longer writes the catalogue it used to merge into.
 */

/** Row → the wire shape. Absent index and duration stay absent, never 0. */
export function toRendition(row: StreamRenditionRow): Rendition {
  const rendition: Rendition = {
    name: row.name,
    width: row.width,
    height: row.height,
    topic: row.topic,
    bandwidth: row.bandwidth,
    avgBandwidth: row.avg_bandwidth,
  };
  if (row.manifest_index !== null) rendition.index = row.manifest_index;
  if (row.duration_seconds !== null) rendition.duration = row.duration_seconds;
  return rendition;
}

/**
 * Whether an element read back off the catalogue is a rung this backend would
 * have written: the six fields every rung carries, and `index` / `duration`
 * numbers when present. The feed is a shared array, and the ladder an entry
 * carries is read before it is trusted, never cast.
 */
export function isRendition(value: unknown): value is Rendition {
  if (typeof value !== 'object' || value === null) return false;
  const rung = value as Record<string, unknown>;
  return (
    typeof rung.name === 'string' &&
    typeof rung.width === 'number' &&
    typeof rung.height === 'number' &&
    typeof rung.topic === 'string' &&
    typeof rung.bandwidth === 'number' &&
    typeof rung.avgBandwidth === 'number' &&
    (rung.index === undefined || typeof rung.index === 'number') &&
    (rung.duration === undefined || typeof rung.duration === 'number')
  );
}

/** A rung's feed topic is a UUID; its case has never been load-bearing. */
function sameTopic(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * What to store for a rung, given what is stored for it now (null when this is
 * the first report for that name) and what just arrived.
 *
 * The incoming report replaces the stored one, with one exception: a stored
 * rung that has finalized keeps its `index` and `duration` when the incoming
 * report has none *and comes in on the same feed topic*. A rung's topic is
 * derived from the stream's declared topic and the rung name, so every report
 * for a rung arrives on the feed that rung's recordings already sit on, and an
 * indexless one is that rung delivering again — recovered from a crash, or a
 * new session above the previous head. Either way the recording it finished
 * last stays addressable at the index it kept, until that rung's next final
 * report replaces it; dropping it meanwhile would take the master playlist a
 * viewer seeks the recording with off the entry. Geometry and bandwidths still
 * come from the incoming report: those describe the encoder running now.
 *
 * The topic test stays because the record it protects is about one feed. It is
 * true for every rung of a well-formed ladder; a report naming some other feed
 * describes a recording this one has nothing to say about, so it is taken as
 * it arrived.
 */
export function mergeRendition(
  stored: Rendition | null,
  incoming: Rendition,
): Rendition {
  if (stored === null) return incoming;
  if (incoming.index !== undefined) return incoming;
  if (stored.index === undefined) return incoming;
  if (!sameTopic(incoming.topic, stored.topic)) return incoming;

  // The topics match, so `incoming` already carries the right one; only what
  // the rung finished with has to be carried over.
  const kept: Rendition = { ...incoming, index: stored.index };
  if (stored.duration !== undefined) kept.duration = stored.duration;
  return kept;
}

/**
 * A ladder is finished when there is one, and every rung of it has reported
 * where its recording ended. An empty ladder is not finished: nothing has been
 * reported, so there is nothing to have finished.
 */
export function isLadderFinished(renditions: readonly Rendition[]): boolean {
  return (
    renditions.length > 0 &&
    renditions.every((rendition) => rendition.index !== undefined)
  );
}

/**
 * How long the recording runs: the longest rung. The rungs are cut from one
 * broadcast and differ by fractions of a segment, and the viewer's seek bar
 * must not stop short of the longest one. Null while the ladder is unfinished.
 */
export function ladderDuration(
  renditions: readonly Rendition[],
): number | null {
  if (!isLadderFinished(renditions)) return null;
  return renditions.reduce(
    (longest, rendition) => Math.max(longest, rendition.duration ?? 0),
    0,
  );
}
