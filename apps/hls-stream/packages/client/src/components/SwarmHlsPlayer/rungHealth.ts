import { Topic } from '@ethersphere/bee-js';
import { SWARM_SCHEME } from '@swarm-hls-stream/shared';
import type Hls from 'hls.js';
import { Events } from 'hls.js';

import type { FeedHealthTracker } from './feedState';
import { parseSwarmUri } from './playlist';

/**
 * The player's side of a ladder's per-rung health: which rung this viewer is on, and what to do when
 * one of them stops being produced.
 *
 * ⛔⛔⛔ **A Swarm feed that stops advancing does not error.** hls.js changes level on a fragment load
 * error, and a feed that has simply stopped offering fragments raises none: the playlist still loads,
 * it just never grows. So a player waiting for a segment it was never offered has nothing to react
 * to. Measured live 2026-08-30 on both byte paths: one rung of four was silenced under a watching
 * viewer, the player stayed on it for the whole outage, the picture stopped for 87 and 103 seconds,
 * and three healthy rungs published beside it the entire time.
 *
 * The poller follows only the playing rung, and judges it by its own progress: when it has been
 * unserved for the stall threshold, or finishes, the poller walks one sibling, and a sibling that shows
 * a new index means the playing rung alone stopped. It announces that rung, and this side takes the
 * level out and moves the viewer to the sibling.
 *
 * ⛔ **Every announced rung is dropped, however many came before** (decision 37, 2026-10-07: "what if we
 * simply allow any drop until one is healthy?"). A cap of one per ladder stood here from 2026-09-01,
 * when an uploader dying read as every rung failing in turn and the player took the ladder apart. The
 * poller no longer condemns a rung for being quiet alone. It fails over only to a sibling it watched
 * make progress, and a broadcast that stops everywhere shows none, so a cascade has nothing to drive it.
 * What the cap did leave was a viewer stuck on the second quality to die, and a refused switch used it
 * up before any real failure came. Only the last level hls.js holds is kept, under the stalled overlay.
 */

/** Below this a ladder has no spare rung, and hls.js refuses to remove the last level anyway. */
const MIN_LEVELS_TO_DROP_ONE = 2;

/**
 * The feed a parsed level reads from, or null when its URI is not one of ours.
 *
 * Null rather than a guess. `parseSwarmUri` splits any string it is handed, so a level pointing at an
 * ordinary URL would come back with a path segment as its topic and hash into a feed nobody is
 * walking, which reads exactly like a rung that has never been served.
 */
function rungTopicOfLevel(uri: string): string | null {
  if (!uri.startsWith(SWARM_SCHEME)) {
    return null;
  }
  const { topic } = parseSwarmUri(uri);
  if (!topic) {
    return null;
  }
  try {
    return Topic.fromString(topic).toString();
  } catch (error) {
    console.warn('A parsed level names a topic that is not usable:', uri, error);
    return null;
  }
}

/** Where a rung sits in the ladder hls.js currently holds, or -1 when it holds no such rung. */
function levelIndexOfRung(hls: Hls, rungTopicId: string): number {
  return hls.levels.findIndex((level) => rungTopicOfLevel(level.uri) === rungTopicId);
}

/**
 * Tell the feed health which rung this viewer is playing, so a fault on it reaches the overlay.
 *
 * ⛔ The overlay subscribes to the group topic, the only one a viewer's link carries, and a group's
 * health is what its rungs agree on. That is right for reaching the gateway and wrong for a feed that
 * has stopped: three healthy rungs outvote the one the viewer can actually see. See
 * `FeedHealthTracker.watchRung`.
 */
export function attachWatchedRungReporter(hls: Hls, groupHexTopic: string, feedHealth: FeedHealthTracker): () => void {
  const report = (_event: unknown, data: { level: number }): void => {
    const level = hls.levels[data.level];
    feedHealth.watchRung(groupHexTopic, level ? rungTopicOfLevel(level.uri) : null);
  };

  hls.on(Events.LEVEL_SWITCHED, report);

  return () => {
    hls.off(Events.LEVEL_SWITCHED, report);
    feedHealth.watchRung(groupHexTopic, null);
  };
}

/**
 * Tell the poller which rung the player is now playing, so it stops following every other one.
 *
 * `LEVEL_SWITCHED` and not the level load, because hls.js keeps playing the old level from its buffer
 * until the new one's media is reached, and the old rung has to stay followed until then.
 *
 * ⛔ The level hls.js is loading is named too, when it is another one. A switch asked before hls.js
 * reports the level it started on is under way when that report arrives, and a poller told only the
 * reported rung would stop the switch target and search for it again when hls.js next asks.
 *
 * ⛔ A switch taken back before it plays names the playing rung alone, so the rung asked for stops.
 */
export function attachActiveRungFollower(
  hls: Hls,
  followOnly: (rungTopicId: string, loadingRungTopicId: string | null) => void,
): () => void {
  const rungOf = (index: number): string | null => {
    const level = hls.levels[index];
    return level ? rungTopicOfLevel(level.uri) : null;
  };
  const follow = (_event: unknown, data: { level: number }): void => {
    const rung = rungOf(data.level);
    if (rung !== null) {
      const loading = rungOf(hls.loadLevel);
      followOnly(rung, loading === rung ? null : loading);
    }
  };

  // hls.js reports LEVEL_SWITCHED once a level's first fragment plays, so a switch it asks for and takes
  // back before then reports nothing, and the rung it asked for would be walked for the session. Going
  // back is a LEVEL_SWITCHING to the level that plays.
  const returnToPlaying = (_event: unknown, data: { level: number }): void => {
    const rung = data.level === hls.currentLevel ? rungOf(data.level) : null;
    if (rung !== null) {
      followOnly(rung, null);
    }
  };

  hls.on(Events.LEVEL_SWITCHED, follow);
  hls.on(Events.LEVEL_SWITCHING, returnToPlaying);

  return () => {
    hls.off(Events.LEVEL_SWITCHED, follow);
    hls.off(Events.LEVEL_SWITCHING, returnToPlaying);
  };
}

/**
 * Take a rung out of the ladder once the poller has found it stopped, so ABR stops choosing it.
 *
 * ⛔⛔ **Removing it is the only thing that lasts.** Reporting the dead rung's playlist as a load error
 * instead was tried on paper and does not hold: hls.js retries twice, switches away by setting
 * `nextAutoLevel`, and then clears that on the first fragment that loads, so ABR is free to pick the
 * dead rung again on the very next segment. On a link fast enough to afford it, that is a viewer
 * oscillating on a three second period for the rest of the broadcast. `removeLevel` is what hls.js
 * itself uses for a level it has decided is unusable, and unlike pinning a level it leaves ABR on.
 *
 * ⚠️ **A removed rung does not come back within the session.** hls.js has no API to put a level back,
 * so a rung that resumes publishing is available again only to viewers who join afterwards. The
 * alternative is rebuilding the player, which costs the viewer their place in a live stream to
 * recover a rung they are not watching.
 *
 * ⛔ **hls.js renumbers the levels on every removal**, so a rung is looked up by its topic on each
 * announcement and never by an index remembered from an earlier one.
 */
export function attachRungFailover(hls: Hls, feedHealth: FeedHealthTracker): () => void {
  return feedHealth.onRungStopped((rungTopicId, detail) => {
    const index = levelIndexOfRung(hls, rungTopicId);
    if (index < 0) {
      // ⛔ Silent until 2026-09-01, and it shares its silence with "the rung was never reported
      // stopped at all". The rung outage arm went red that day having logged NOTHING: no drop, no refusal, no
      // detection, so the two had to be told apart by reasoning rather than by reading. Most
      // announcements really are another ladder's and this is the right answer for them, which is
      // why it says which ladder rather than warning.
      console.debug(
        `[SwarmHls] rung ${rungTopicId} was reported stopped and is not one of this player's ` +
          `${hls.levels.length} level(s), so there is nothing to drop`,
      );
      return;
    }

    const level = hls.levels[index];
    // ⛔ The reason that condemned it, in the line that announces it. A warning saying only that a rung
    // stopped cannot be checked against the broadcast afterwards, and on 2026-08-31 that cost two live
    // test runs.
    const reason = detail.reason;
    if (hls.levels.length < MIN_LEVELS_TO_DROP_ONE) {
      console.warn(
        `Rung ${level.height}p has stopped being produced (${reason}) and is the only one left, so playback stays on it`,
      );
      return;
    }

    // ⛔ Read BEFORE the removal, because the removal is what sets `loadLevel` to -1 and the two
    // reasons it can be -1 must not be confused. A player that has not chosen a level yet is also at
    // -1, and steering that one forces a level while hls.js is still settling the ladder. Only a
    // viewer whose own rung was just taken away needs somewhere to go.
    const tookThePlayingLevel = hls.loadLevel === index;

    console.warn(`Rung ${level.height}p has stopped being produced (${reason}), dropping it from the ladder`);
    hls.removeLevel(index);

    // hls.js clears the current level when the removed one was playing, and nothing else picks a
    // replacement. Left at -1 the player buffers out and stops, which is the freeze this exists to
    // end. The poller names the rung it found moving, which is the one the viewer goes to. Read after
    // the removal, because hls.js renumbers the levels above it. Without one, ABR chooses.
    if (tookThePlayingLevel) {
      const target = detail.failoverTo === null ? -1 : levelIndexOfRung(hls, detail.failoverTo);
      hls.nextLoadLevel = target >= 0 ? target : hls.nextAutoLevel;
    }
  });
}
