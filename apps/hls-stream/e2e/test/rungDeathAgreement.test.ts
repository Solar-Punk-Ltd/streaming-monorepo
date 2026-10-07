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
 * How many rungs each side will act on at once, set on 2026-09-01 after a broadcast ending
 * made the player delete three rungs of four and hls.js go fatal.
 *
 * ⚠️ The two names differ on purpose. The player's removal is irreversible, so its limit is per
 * session; the uploader recomputes what to advertise on every delivery, so its limit is per
 * evaluation. Same number, different sentence, and they must not drift apart: a master that drops a
 * rung the player kept, or keeps one the player dropped, is a viewer-side fault a long way from the
 * number that caused it.
 */
const DROP_LIMITS = {
  'the player': ['packages/client/src/components/SwarmHlsPlayer/rungHealth.ts', 'MAX_RUNGS_DROPPED_PER_LADDER'],
  'the uploader': ['packages/stream-uploader/src/libs/LadderLiveness.ts', 'MAX_RUNGS_DROPPED_AT_ONCE'],
} as const;

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

describe('the player and the master agree how much of a ladder may be dropped at once', () => {
  for (const [whose, [file, name]] of Object.entries(DROP_LIMITS)) {
    it(`finds ${name} declared in ${whose}`, () => {
      assert.notEqual(
        declaredValueOf(join(ROOT_DIR, file), name),
        null,
        `${name} is not declared in ${file}. Either it was renamed, or one side stopped limiting how ` +
          'much of a ladder it will take apart, which is the failure this limit was ruled in to stop.',
      );
    });
  }

  it('reads the same number on both sides', () => {
    const [player, uploader] = Object.values(DROP_LIMITS).map(([file, name]) =>
      declaredValueOf(join(ROOT_DIR, file), name),
    );

    assert.equal(
      player,
      uploader,
      `the player will drop ${player} rung(s) and the master will drop ${uploader}. They must match, ` +
        'or the two disagree about which rungs exist and neither says so.',
    );
  });

  /**
   * ⛔ Pinned to the ruling rather than only to each other, because "both sides say 3" would satisfy
   * the equality above and is not what was decided.
   */
  it('is one, which is what a broadcast ending needs', () => {
    for (const [whose, [file, name]] of Object.entries(DROP_LIMITS)) {
      assert.equal(
        declaredValueOf(join(ROOT_DIR, file), name),
        1,
        `${whose} would take ${declaredValueOf(join(ROOT_DIR, file), name)} rungs out of a ladder. The ` +
          'ruling was one: a second rung going quiet is a broadcast ending, not two rungs failing.',
      );
    }
  });
});
