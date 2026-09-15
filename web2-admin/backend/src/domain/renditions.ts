import type { Rendition } from '@streaming-monorepo/web2-admin-common';

import type { StreamRenditionRow } from '../types/index.js';

/**
 * The ABR ladder's vocabulary: what a stored rung looks like on the wire, how
 * a fresh report is folded into the one already stored, and when the ladder as
 * a whole counts as finished.
 *
 * The fold is the part with history behind it. It is `keepingWhatFinished` from
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
 * report has none *and comes in on the same feed topic*. A rung that comes back
 * after a crash announces itself before it finalizes again, and replacing
 * wholesale would flip a finished ladder back to unfinished — and with it the
 * master playlist the viewer needs to seek a recording. Geometry and bandwidths
 * still come from the incoming report: those describe the encoder running now.
 *
 * The topic is what tells that recovery apart from a new session of the same
 * rung. A crashed rung resumes writing the feed it was already writing, so its
 * topic is unchanged; a rung that starts again — the encoder reconnected after
 * the ladder finished, or one transcode restarted while its siblings kept going
 * — mints a fresh random topic. So an indexless report on a *different* topic
 * is a rung that is live again, and it replaces the finished record. Keeping
 * the old one instead would leave the master advertising the recording's rung
 * feeds while the feeds now being written went unadvertised.
 */
export function foldRendition(
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
