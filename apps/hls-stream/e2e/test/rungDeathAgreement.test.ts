import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ROOT_DIR } from '../src/config.js';

/**
 * The player and the master each decide when a rung has stopped, and this holds what each side declares.
 *
 * Until 2026-10-07 there were two copies of one rule, the player's in `feedState.ts` and the uploader's
 * in `packages/stream-uploader/src/libs/LadderLiveness.ts`, and they had to agree, because a master
 * naming a rung the player had left reads as a viewer-side fault a long way from the number that
 * caused it. The player has since moved to judging the rung it plays by that rung's own progress.
 *
 * Read out of the source rather than imported. e2e must not reach past a package boundary into
 * another package's internals, and the client is a browser package this runner cannot load anyway.
 * Same mirror-and-prove arrangement as `logLevel.test.ts` against the uploader's call sites and
 * `ports.test.ts` against `_lib.sh`.
 */

const CONSTANT = 'RUNG_DEATH_LAG_SEGMENTS';

/**
 * How many rungs the uploader takes out of what the master advertises at once, set on 2026-09-01
 * after a broadcast ending made the player delete three rungs of four and hls.js go fatal.
 *
 * ⛔ The player had the same limit, `MAX_RUNGS_DROPPED_PER_LADDER`, until decision 37 on 2026-10-07:
 * it now drops every rung it announces until the viewer is on one that moves. It announces a rung only
 * while another rung is seen moving, the playing one at a refused switch or a sibling at a failover, and
 * a broadcast that stops everywhere shows none, so the cascade the limit was ruled in to stop has
 * nothing to drive it. The uploader keeps its limit for the
 * master, and the player's is pinned as absent, so a cap coming back into it is looked at.
 */
const UPLOADER_DROP_LIMIT = 'MAX_RUNGS_DROPPED_AT_ONCE';
const PLAYER_DROP_LIMIT = 'MAX_RUNGS_DROPPED_PER_LADDER';
const PLAYER_RUNG_HEALTH = join(ROOT_DIR, 'packages', 'client', 'src', 'components', 'SwarmHlsPlayer', 'rungHealth.ts');

/**
 * ⛔ **The player left this rule on 2026-10-07.** It follows only the quality it plays and judges that
 * quality by its own progress, confirmed by one sibling that moves, because the rungs' feeds drift
 * apart without bound and a count of segments one rung is behind the others stopped meaning anything
 * once only one rung is read. The uploader keeps its count for what the master advertises. The player
 * reads that master once at most, and not at all when the stream list names the renditions, so the
 * two no longer have to agree. The player's side is pinned as absent, so a lag rule coming back into
 * it is looked at rather than mirrored.
 */
const PLAYER_FEED_STATE = join(ROOT_DIR, 'packages', 'client', 'src', 'components', 'SwarmHlsPlayer', 'feedState.ts');
const UPLOADER_LIVENESS = join(ROOT_DIR, 'packages', 'stream-uploader', 'src', 'libs', 'LadderLiveness.ts');

/** The declared value of `name` in `path`, or null when it is not declared there at all. */
function declaredValueOf(path: string, name: string): number | null {
  const found = new RegExp(`${name}\\s*(?::\\s*number)?\\s*=\\s*(\\d+)`).exec(readFileSync(path, 'utf8'));
  return found ? Number(found[1]) : null;
}

function declaredValue(path: string): number | null {
  return declaredValueOf(path, CONSTANT);
}

describe('when a rung has stopped', () => {
  it(`finds ${CONSTANT} declared in the uploader, which decides what the master advertises`, () => {
    assert.notEqual(
      declaredValue(UPLOADER_LIVENESS),
      null,
      `${CONSTANT} is not declared in ${UPLOADER_LIVENESS}. Either it was renamed, in which case rename it ` +
        'here too, or the uploader stopped using segment lag to judge a rung, which is a change this test ' +
        'exists to make someone look at rather than a rename.',
    );
  });

  it(`finds ${CONSTANT} gone from the player, which judges the rung it plays by its own progress`, () => {
    assert.equal(
      declaredValue(PLAYER_FEED_STATE),
      null,
      `${CONSTANT} is declared in ${PLAYER_FEED_STATE} again. The player follows one rung, so a count of ` +
        'segments the others delivered is not something it can read. Look at why it came back.',
    );
  });
});

describe('how much of a ladder may be dropped at once', () => {
  it(`finds ${UPLOADER_DROP_LIMIT} declared in the uploader`, () => {
    assert.notEqual(
      declaredValueOf(UPLOADER_LIVENESS, UPLOADER_DROP_LIMIT),
      null,
      `${UPLOADER_DROP_LIMIT} is not declared in ${UPLOADER_LIVENESS}. Either it was renamed, or the uploader ` +
        'stopped limiting how much of a ladder the master stops advertising at once, which is the failure ' +
        'this limit was ruled in to stop.',
    );
  });

  /**
   * ⛔ Pinned to the ruling, because a different number would satisfy the presence check above and is
   * not what was decided.
   */
  it('is one in the uploader, which is what a broadcast ending needs', () => {
    assert.equal(
      declaredValueOf(UPLOADER_LIVENESS, UPLOADER_DROP_LIMIT),
      1,
      `the uploader would take ${declaredValueOf(UPLOADER_LIVENESS, UPLOADER_DROP_LIMIT)} rungs out of the ` +
        'master at once. The ruling was one: a second rung going quiet is a broadcast ending, not two rungs failing.',
    );
  });

  it(`finds ${PLAYER_DROP_LIMIT} gone from the player, which drops until the viewer is on a rung that moves`, () => {
    assert.equal(
      declaredValueOf(PLAYER_RUNG_HEALTH, PLAYER_DROP_LIMIT),
      null,
      `${PLAYER_DROP_LIMIT} is declared in ${PLAYER_RUNG_HEALTH} again. Decision 37 took the player's cap out, ` +
        'because a refused switch used it up and left a viewer frozen on the next rung to stop.',
    );
  });
});
