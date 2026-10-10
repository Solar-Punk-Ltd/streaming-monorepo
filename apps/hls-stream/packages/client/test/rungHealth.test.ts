import { Topic } from '@ethersphere/bee-js';
import { buildSwarmUri } from '@swarm-hls-stream/shared';
import type Hls from 'hls.js';
import { Events } from 'hls.js';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  FEED_STATE_LIVE,
  FEED_STATE_STALLED,
  FeedHealthTracker,
  UNSERVED_SLOT_STALL_MS,
} from '../src/components/SwarmHlsPlayer/feedState';
import {
  attachActiveRungFollower,
  attachRungFailover,
  attachWatchedRungReporter,
} from '../src/components/SwarmHlsPlayer/rungHealth';

const OWNER = '0x1234567890123456789012345678901234567890';
const GROUP = 'the-broadcast-a-viewer-linked-to';

/** The rungs of the ladder this project publishes, tallest first, as the poller names them. */
const RUNG_NAMES = ['rung-1080p', 'rung-720p', 'rung-480p', 'rung-360p'] as const;
const HEIGHTS = [1080, 720, 480, 360] as const;

const hexOf = (rung: string): string => Topic.fromString(rung).toString();

function makeClock() {
  let ms = 0;
  return { now: () => ms, advance: (by: number) => void (ms += by) };
}

/**
 * What the poller says once it has found a rung stopped: a sibling showed a new index while this rung
 * showed none, or the rung was refused at a switch. The judgement is the poller's and is tested there
 * (`test/oneQualityFollow.test.ts`). This side only acts on the announcement.
 */
function announceStopped(feedHealth: FeedHealthTracker, deadRung: string, failoverTo: string | null = null): void {
  feedHealth.recordRungStopped(hexOf(deadRung), {
    reason: 'it stopped while a sibling carries on',
    failoverTo: failoverTo === null ? null : hexOf(failoverTo),
  });
}

/**
 * A player holding a parsed four rung ladder, and the tracker walking the same four feeds.
 *
 * The double answers what the two attach functions actually touch: the level list, the level
 * currently loading, and the two events. `removeLevel` reproduces hls.js's own behaviour, which is
 * what makes the index question real: it drops the entry, so every level above it shifts down, and
 * it clears the current level when the removed one was playing.
 *
 * ⛔ `walked` and `parsed` are separate because they genuinely come apart: the poller registers every
 * rung while hls.js only holds the levels it still has, so after a rung has been dropped the two sets
 * differ, and that is exactly the state the last-rung case has to be set up in.
 */
function makeLadderPlayer({
  walked = RUNG_NAMES,
  parsed = walked,
}: { walked?: readonly string[]; parsed?: readonly string[] } = {}) {
  const clock = makeClock();
  const feedHealth = new FeedHealthTracker(clock.now);
  feedHealth.trackGroup(GROUP, walked.map(hexOf));

  const switchedListeners = new Set<(event: unknown, data: { level: number }) => void>();
  const switchingListeners = new Set<(event: unknown, data: { level: number }) => void>();
  const removed: number[] = [];
  const loadStarts: number[] = [];

  const hls = {
    levels: parsed.map((rung) => ({
      uri: buildSwarmUri(OWNER, rung),
      height: HEIGHTS[RUNG_NAMES.indexOf(rung as (typeof RUNG_NAMES)[number])],
      details: { heldFrom: 'an earlier visit to this rung' } as object | undefined,
    })),
    loadLevel: 0,
    currentLevel: -1,
    nextLoadLevel: -1,
    nextAutoLevel: 1,
    loadingEnabled: true,
    hasEnoughToStart: true,
    startLoad(startPosition = -1) {
      loadStarts.push(startPosition);
    },
    removeLevel(index: number) {
      removed.push(index);
      if (this.levels.length === 1) {
        return;
      }
      const wasLoading = index === this.loadLevel;
      this.levels = this.levels.filter((_level, at) => at !== index);
      if (wasLoading) {
        this.loadLevel = -1;
      }
    },
    on(event: string, listener: (event: unknown, data: { level: number }) => void) {
      if (event === Events.LEVEL_SWITCHING) {
        switchingListeners.add(listener);
        return;
      }
      assert.equal(event, Events.LEVEL_SWITCHED, `the reporter listened for ${event}`);
      switchedListeners.add(listener);
    },
    off(event: string, listener: (event: unknown, data: { level: number }) => void) {
      if (event === Events.LEVEL_SWITCHED) {
        switchedListeners.delete(listener);
      }
      if (event === Events.LEVEL_SWITCHING) {
        switchingListeners.delete(listener);
      }
    },
  };

  return {
    clock,
    feedHealth,
    hls: hls as unknown as Hls,
    removed,
    loadStarts,
    stopLoading: () => void (hls.loadingEnabled = false),
    /** No fragment has been buffered yet, which is when hls.js's `startLoad` picks its start level itself. */
    notStartedYet: () => void (hls.hasEnoughToStart = false),
    playlistHeld: (height: number) => hls.levels.find((level) => level.height === height)?.details,
    heightsLeft: () => hls.levels.map((level) => level.height),
    loadLevel: () => hls.loadLevel,
    setLoadLevel: (level: number) => void (hls.loadLevel = level),
    nextLoadLevel: () => hls.nextLoadLevel,
    /** hls.js has played the first fragment of this level, which is when it reports the switch. */
    switchTo: (level: number) => {
      hls.currentLevel = level;
      for (const listener of switchedListeners) {
        listener(Events.LEVEL_SWITCHED, { level });
      }
    },
    /** hls.js starts loading this level, which it announces before any of it plays. */
    startLoading: (level: number) => {
      hls.loadLevel = level;
      for (const listener of switchingListeners) {
        listener(Events.LEVEL_SWITCHING, { level });
      }
    },
    /** The poller announcing one of this player's rungs as stopped. */
    silence: (rung: string, failoverTo: string | null = null) => announceStopped(feedHealth, rung, failoverTo),
    /** One rung unserved for the stall threshold while the poller follows it. */
    goQuiet: (rung: string) => {
      feedHealth.recordUnservedSlot(hexOf(rung));
      clock.advance(UNSERVED_SLOT_STALL_MS);
      feedHealth.recordUnservedSlot(hexOf(rung));
    },
  };
}

/**
 * ⛔⛔⛔ **A Swarm feed that stops advancing does not error, so hls.js never switches away from it.**
 *
 * Measured live on 2026-08-30, both byte paths, one rung of four silenced under a watching viewer:
 * the player stayed on the dead rung for the whole outage, the picture stopped for 87.2 seconds in
 * the tab and 103.2 through a gateway, and three healthy rungs published beside it throughout.
 * hls.js changes level on a fragment load error, and a rung whose transcode has stopped still serves
 * its playlist perfectly. It just never grows.
 */
describe('dropping a rung that has stopped being produced', () => {
  it('takes the dead rung out of the ladder', () => {
    const player = makeLadderPlayer();
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-1080p');

    assert.deepEqual(player.heightsLeft(), [720, 480, 360]);
  });

  /**
   * ⛔⛔ **Any number of drops, until the viewer is on a quality that moves** (decision 37, 2026-10-07).
   *
   * A cap of one used to stand here, bought by a live test on 2026-09-01 where an uploader dying read as
   * every rung failing in turn. The poller no longer announces a rung for being quiet alone: it fails
   * over only to a sibling it watched make progress, and a broadcast that stops everywhere shows no such
   * sibling. So every announcement names a rung that stopped while another carries on, and a cap only
   * left a viewer stuck on the second one to die.
   */
  it('drops two qualities that die one after the other and leaves the viewer on the third', () => {
    const player = makeLadderPlayer();
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-1080p', 'rung-720p');
    assert.equal(player.nextLoadLevel(), 0, 'the viewer was not moved to 720p');
    player.setLoadLevel(0);
    player.silence('rung-720p', 'rung-480p');

    assert.deepEqual(player.heightsLeft(), [480, 360], 'the second quality to die was left in the ladder');
    assert.equal(player.nextLoadLevel(), 0, 'the viewer was not moved on to 480p');
  });

  /** ⛔ A refusal takes a quality nobody plays out of the ladder, and must not stand in the way of a real failover. */
  it('still fails over on a real failure after a switch was refused', () => {
    const player = makeLadderPlayer();
    // The viewer plays 1080p and asked for 720p, which was found stale and refused.
    player.setLoadLevel(1);
    attachRungFailover(player.hls, player.feedHealth);
    player.silence('rung-720p', 'rung-1080p');
    player.setLoadLevel(0);

    player.silence('rung-1080p', 'rung-480p');

    assert.deepEqual(player.heightsLeft(), [480, 360]);
    assert.equal(player.nextLoadLevel(), 0, 'the viewer was left on the quality that stopped');
  });

  it('drops every quality that dies in turn but never the last level', () => {
    const player = makeLadderPlayer();
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-1080p', 'rung-720p');
    player.silence('rung-720p', 'rung-480p');
    player.silence('rung-480p', 'rung-360p');
    player.silence('rung-360p');

    assert.deepEqual(player.heightsLeft(), [360], 'the last level went too');
    assert.deepEqual(player.removed, [0, 0, 0], 'the last level was handed to removeLevel');
  });

  /**
   * Every player on the page hears every announcement, and most of them are about other ladders.
   *
   * ⛔ The other broadcast's rung has to really be announced, or this case would pass on there being no
   * announcement at all rather than on one being correctly ignored.
   */
  it('ignores a rung this player is not holding', () => {
    const player = makeLadderPlayer();
    const otherDead = 'a-rung-of-someone-elses-broadcast';
    const otherLive = 'the-rung-someone-else-is-watching';
    const heard: string[] = [];
    player.feedHealth.onRungStopped((rung) => heard.push(rung));
    attachRungFailover(player.hls, player.feedHealth);

    announceStopped(player.feedHealth, otherDead, otherLive);

    assert.deepEqual(heard, [hexOf(otherDead)], 'the other ladder should have announced its own dead rung');
    assert.deepEqual(player.removed, []);
    assert.deepEqual(player.heightsLeft(), [...HEIGHTS]);
  });

  /**
   * A viewer with one rung left is better off frozen on it than left with no ladder at all.
   *
   * ⛔ Asserted on the call rather than on the outcome. hls.js refuses to remove the last level
   * itself, so a test that only checked the level survived would pass with no guard here at all, and
   * the recovery below would then run against a ladder nothing had been taken out of.
   */
  it('leaves the last rung alone, without asking hls.js to drop it', () => {
    // Every other rung has already been dropped, which is where a run of these leaves a player.
    const player = makeLadderPlayer({ parsed: ['rung-1080p'] });
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-1080p');

    assert.deepEqual(player.removed, [], 'the last level was handed to removeLevel anyway');
    assert.deepEqual(player.heightsLeft(), [1080]);
  });

  /**
   * ⛔ hls.js clears the loading level when the removed one was playing and picks no replacement.
   * Left at -1 the player buffers out and stops, which is the freeze this whole change exists to end.
   */
  it('puts the viewer on a living rung when the one they were playing is removed', () => {
    const player = makeLadderPlayer();
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-1080p');

    assert.equal(player.loadLevel(), -1, 'the double should reproduce hls.js clearing the loading level');
    assert.equal(player.nextLoadLevel(), 1, 'the viewer was left with no level to load, so the picture stops');
  });

  it('puts the viewer on the rung the poller found moving, counted after the removal renumbers the levels', () => {
    const player = makeLadderPlayer();
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-1080p', 'rung-480p');

    // 480p was level 2 before 1080p went, and is level 1 after.
    assert.equal(player.nextLoadLevel(), 1);
    assert.deepEqual(player.heightsLeft(), [720, 480, 360]);
  });

  /**
   * The SRS restart of 2026-10-08 (round 3, the viewer on a fast line). 360p was dropped while it played and
   * 1080p inherited its level number, so hls.js read 1080p's first fragment as the next one of the same level
   * and kept its video running on from 360p's last frame while its audio went where the playlist put it, 16 s
   * earlier. The picture and the sound never overlapped where hls.js kept seeking to, every 6 s, and the
   * viewer saw nothing for 8.8 minutes. Restarting the load is how hls.js forgets the fragment it appended last.
   */
  it('restarts loading when the playing rung is dropped, so the next rung is not appended as its continuation', () => {
    const player = makeLadderPlayer();
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-1080p', 'rung-720p');

    assert.equal(player.nextLoadLevel(), 0);
    assert.deepEqual(player.loadStarts, [-1], 'the next fragment would be appended as the dropped rung continuing');
  });

  /**
   * The poller forgets a rung's playlist when it stops following it, so what hls.js still holds for that level is
   * a playlist from an earlier visit, minutes old. hls.js places a reloaded live playlist against that by counting
   * sequence numbers at the target duration, which put 1080p 16 s away from the rung it replaced. Without it hls.js
   * places the playlist by date beside the rung it last played.
   */
  it('forgets the playlist the next rung held from an earlier visit, so hls.js places it by date', () => {
    const player = makeLadderPlayer();
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-1080p', 'rung-720p');

    assert.equal(player.playlistHeld(720), undefined, 'hls.js would align 720p against its minutes old playlist');
    assert.notEqual(player.playlistHeld(480), undefined, 'a rung nobody is moving to lost its playlist');
  });

  it('leaves loading stopped for a viewer who paused', () => {
    const player = makeLadderPlayer();
    player.stopLoading();
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-1080p', 'rung-720p');

    assert.deepEqual(player.loadStarts, [], 'a paused player started loading again');
  });

  /**
   * A refused switch hands the viewer back to the rung they play, while hls.js was loading the refused one. That
   * rung's playlist is the one hls.js aligns the playing rung's next reload against, since the refused playlist
   * never reached it, so forgetting it would let hls.js place the playing rung at nothing and seek the viewer.
   */
  it('keeps the playlist of the rung the viewer plays and leaves loading alone when a refused switch hands them back to it', () => {
    const player = makeLadderPlayer();
    player.switchTo(0);
    player.setLoadLevel(1);
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-720p', 'rung-1080p');

    assert.equal(player.nextLoadLevel(), 0);
    assert.notEqual(player.playlistHeld(1080), undefined, 'the rung the viewer plays lost its playlist');
    assert.deepEqual(player.loadStarts, [], 'a refused switch restarted loading on the rung the viewer plays');
  });

  /**
   * Before any fragment is buffered `startLoad` sets the next level to hls.js's start level, which would undo the
   * move to the rung the poller found moving. Nothing has been appended then, so there is no fragment to forget.
   */
  it('does not restart loading before the first fragment, so the viewer stays on the rung they were moved to', () => {
    const player = makeLadderPlayer();
    player.notStartedYet();
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-1080p', 'rung-720p');

    assert.equal(player.nextLoadLevel(), 0);
    assert.deepEqual(player.loadStarts, [], 'startLoad would have replaced the rung the viewer was moved to');
  });

  it('does not restart loading when the dropped rung was not the one playing', () => {
    const player = makeLadderPlayer();
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-480p');

    assert.deepEqual(player.loadStarts, []);
    assert.notEqual(player.playlistHeld(1080), undefined, 'the playing rung lost its playlist');
  });

  it('keeps a viewer whose switch was refused on the rung they play', () => {
    const player = makeLadderPlayer();
    // hls.js was loading 720p, the switch target, while the viewer still plays 1080p from its buffer.
    player.setLoadLevel(1);
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-720p', 'rung-1080p');

    assert.equal(player.nextLoadLevel(), 0, 'a refused switch moved the viewer off the rung they play');
  });

  it('leaves the loading level alone when the dead rung was not the one playing', () => {
    const player = makeLadderPlayer();
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-480p');

    assert.equal(player.nextLoadLevel(), -1, 'a viewer watching a healthy rung was steered off it');
  });

  /**
   * ⛔ The other reason `loadLevel` is -1. A player that has not chosen a level yet reads exactly like
   * one whose level was just removed, and steering the first forces a level while hls.js is still
   * settling the ladder. The gateway outage arm removed a rung from a freshly restarted player on 2026-08-30 and that
   * viewer's playhead never left zero.
   */
  it('does not steer a player that had not chosen a level in the first place', () => {
    const player = makeLadderPlayer();
    player.setLoadLevel(-1);
    attachRungFailover(player.hls, player.feedHealth);

    player.silence('rung-480p');

    assert.deepEqual(player.heightsLeft(), [1080, 720, 360], 'the dead rung should still be dropped');
    assert.equal(player.nextLoadLevel(), -1, 'a player still settling its ladder was forced onto a level');
  });

  it('stops dropping rungs once the player is torn down', () => {
    const player = makeLadderPlayer();
    const detach = attachRungFailover(player.hls, player.feedHealth);

    detach();
    player.silence('rung-1080p');

    assert.deepEqual(player.heightsLeft(), [...HEIGHTS]);
  });
});

/**
 * ⛔⛔⛔ The overlay watches the group topic and nothing else, and a group's health is what its rungs
 * agree on. Three healthy rungs outvote the one the viewer can actually see, which is why a viewer
 * frozen for 87 seconds on a dead rung was told the stream was live for every one of them.
 */
describe('telling the feed health which rung this viewer is on', () => {
  it('names the rung the player switched to', () => {
    const player = makeLadderPlayer();
    attachWatchedRungReporter(player.hls, GROUP, player.feedHealth);

    player.switchTo(0);
    player.goQuiet('rung-1080p');

    assert.equal(player.feedHealth.state(GROUP), FEED_STATE_STALLED);
  });

  it('follows the viewer onto a rung that is still publishing', () => {
    const player = makeLadderPlayer();
    attachWatchedRungReporter(player.hls, GROUP, player.feedHealth);

    player.switchTo(0);
    player.goQuiet('rung-1080p');
    player.switchTo(3);

    assert.equal(player.feedHealth.state(GROUP), FEED_STATE_LIVE);
  });

  /** A level index hls.js no longer holds. Naming nothing is right: naming a wrong rung is not. */
  it('names no rung when the index is past the ladder', () => {
    const player = makeLadderPlayer();
    attachWatchedRungReporter(player.hls, GROUP, player.feedHealth);

    player.switchTo(0);
    player.switchTo(99);
    player.goQuiet('rung-1080p');

    assert.equal(player.feedHealth.state(GROUP), FEED_STATE_LIVE, 'a rung out of range was still being watched');
  });

  it('lets go of the rung when the player is torn down', () => {
    const player = makeLadderPlayer();
    const detach = attachWatchedRungReporter(player.hls, GROUP, player.feedHealth);
    player.switchTo(0);

    detach();
    player.goQuiet('rung-1080p');

    assert.equal(player.feedHealth.state(GROUP), FEED_STATE_LIVE, 'a destroyed player was still choosing the overlay');
  });
});

describe('telling the poller which rung the player now plays', () => {
  it('names the rung of the level hls.js switched to', () => {
    const player = makeLadderPlayer();
    const followed: string[] = [];
    attachActiveRungFollower(player.hls, (rung) => followed.push(rung));

    player.switchTo(2);

    assert.deepEqual(followed, [hexOf('rung-480p')]);
  });

  it('names the level hls.js is loading as well, while a switch is under way past the one it reports', () => {
    const player = makeLadderPlayer();
    const followed: [string, string | null][] = [];
    attachActiveRungFollower(player.hls, (rung, loading) => followed.push([rung, loading]));

    // A switch to the lowest level was asked before hls.js reported the level it started on.
    player.setLoadLevel(3);
    player.switchTo(0);
    player.switchTo(3);

    assert.deepEqual(followed, [
      [hexOf('rung-1080p'), hexOf('rung-360p')],
      [hexOf('rung-360p'), null],
    ]);
  });

  it('names the playing rung alone when hls.js goes back to it before the level it asked for plays', () => {
    const player = makeLadderPlayer();
    const followed: [string, string | null][] = [];
    attachActiveRungFollower(player.hls, (rung, loading) => followed.push([rung, loading]));
    player.startLoading(0);
    player.switchTo(0);

    // A switch down is asked and taken back before any of it plays, so no LEVEL_SWITCHED follows.
    player.startLoading(2);
    player.startLoading(0);

    assert.deepEqual(followed, [
      [hexOf('rung-1080p'), null],
      [hexOf('rung-1080p'), null],
    ]);
  });

  /**
   * The poller forgets the playlist of every rung it stops following and starts a new one from the rung's newest
   * window when it follows it again. hls.js keeps the old one on the level and places the new one against it by
   * counting sequence numbers at the target duration, which is wrong by every short segment and gap in between, so
   * an ABR switch back up jumped or met a hole. A level holding no playlist is placed by date instead.
   */
  it('forgets the playlists of the rungs the poller stops following, so a switch back places them by date', () => {
    const player = makeLadderPlayer();
    attachActiveRungFollower(player.hls, () => {});

    player.setLoadLevel(2);
    player.switchTo(2);

    assert.notEqual(player.playlistHeld(480), undefined, 'the playing rung lost its playlist');
    assert.deepEqual(
      [1080, 720, 360].map((height) => player.playlistHeld(height)),
      [undefined, undefined, undefined],
      'a rung the poller stopped following kept a playlist hls.js would align the next one against',
    );
  });

  it('keeps the playlist of the level hls.js is loading while a switch is under way', () => {
    const player = makeLadderPlayer();
    attachActiveRungFollower(player.hls, () => {});

    player.setLoadLevel(3);
    player.switchTo(0);

    assert.notEqual(player.playlistHeld(1080), undefined, 'the playing rung lost its playlist');
    assert.notEqual(player.playlistHeld(360), undefined, 'the switch target lost its playlist');
    assert.equal(player.playlistHeld(720), undefined);
  });

  it('forgets the playlist of a switch taken back before it played', () => {
    const player = makeLadderPlayer();
    attachActiveRungFollower(player.hls, () => {});
    player.startLoading(0);
    player.switchTo(0);

    player.startLoading(2);
    player.startLoading(0);

    assert.equal(player.playlistHeld(480), undefined, 'the rung asked for and abandoned kept its playlist');
    assert.notEqual(player.playlistHeld(1080), undefined, 'the playing rung lost its playlist');
  });

  it('names nothing for a level index past the ladder, and nothing once torn down', () => {
    const player = makeLadderPlayer();
    const followed: string[] = [];
    const detach = attachActiveRungFollower(player.hls, (rung) => followed.push(rung));

    player.switchTo(99);
    detach();
    player.switchTo(0);

    assert.deepEqual(followed, []);
  });
});
