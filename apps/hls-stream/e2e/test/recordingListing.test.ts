import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rungPlaylistParse } from '../src/harness/manifestContractLive.js';
import {
  recordingRefusal,
  recordingRungOf,
  sessionGrowthRefusal,
  sessionsByRung,
  uploadsPerRecordingRung,
} from '../src/harness/recordingListing.js';

import { FIXTURE_FRAGMENT_SECONDS, gluedRecording, rungPlaylist } from './helpers/rungPlaylistFixtures.js';

const feed = (rung: string) => ({ rung, streamId: `live/stream_${rung}`, topic: `group-a-${rung}` });
const finished = (rung: string, sessions: number[], inherited = {}) =>
  recordingRungOf(rungPlaylistParse(feed(rung), gluedRecording(sessions, inherited)));

const LADDER = ['360p', '1080p'];

describe('recordingRungOf', () => {
  it('counts segments, seconds, breaks and sessions off a recording glued from two sessions', () => {
    const rung = finished('360p', [10, 5]);
    assert.equal(rung.recording, true);
    assert.equal(rung.segments, 15);
    assert.equal(rung.durationSeconds, 15 * FIXTURE_FRAGMENT_SECONDS);
    assert.equal(rung.discontinuities, 1);
    assert.equal(rung.sessions, 2);
  });

  it('counts a seam that ran in front of the first entry, which only the discontinuity sequence declares', () => {
    assert.equal(finished('360p', [10, 5], { mediaSequence: 40, discontinuitySequence: 1 }).sessions, 3);
  });

  it('reads a live window as no recording', () => {
    const live = recordingRungOf(rungPlaylistParse(feed('360p'), rungPlaylist([0, 1, 2])));
    assert.equal(live.recording, false);
  });
});

describe('recordingRefusal', () => {
  const expectation = { rungs: LADDER, sessions: 2, fragmentSeconds: FIXTURE_FRAGMENT_SECONDS };

  it('passes a recording that holds every rung, the same length, every session', () => {
    assert.equal(recordingRefusal(LADDER, [finished('360p', [10, 5]), finished('1080p', [10, 5])], expectation), null);
  });

  it('refuses a rung that kept only the last session, the 2026-10-14 shape', () => {
    const refusal = recordingRefusal(LADDER, [finished('360p', [10, 5]), finished('1080p', [5])], expectation);
    assert.match(refusal ?? '', /1080p glued 1 session\(s\) where the broadcast made 2/);
    assert.match(refusal ?? '', /1080p 10\.0s fall more than one/);
  });

  it('refuses a rung the master no longer offers and a rung whose head is still live', () => {
    const live = recordingRungOf(rungPlaylistParse(feed('1080p'), rungPlaylist([0, 1, 2])));
    const refusal = recordingRefusal(['360p'], [finished('360p', [10, 5]), live], expectation);
    assert.match(refusal ?? '', /does not offer 1080p/);
    assert.match(refusal ?? '', /1080p holds no finished recording \(its head is a live window\)/);
  });

  it('takes a session count per rung, as after one rung restarted', () => {
    const perRung = { ...expectation, sessions: new Map([['1080p', 2]]) };
    assert.equal(recordingRefusal(LADDER, [finished('360p', [15]), finished('1080p', [10, 5])], perRung), null);
  });

  it('refuses a recording shorter than the segments the broadcast published', () => {
    const refusal = recordingRefusal(LADDER, [finished('360p', [10]), finished('1080p', [10])], {
      ...expectation,
      sessions: 1,
      minSegments: 1200,
    });
    assert.match(refusal ?? '', /360p holds 10 segment\(s\) where at least 1200 were published/);
  });

  it('leaves a rung the scenario silenced on purpose out of the equal-length rule, and nothing else', () => {
    const silenced = { ...expectation, sessions: new Map([['1080p', 2]]), shortOnPurpose: ['1080p'] };
    assert.equal(recordingRefusal(LADDER, [finished('360p', [20]), finished('1080p', [5, 5])], silenced), null);
    const three = ['360p', '720p', '1080p'];
    assert.match(
      recordingRefusal(three, [finished('360p', [20]), finished('720p', [5]), finished('1080p', [5, 5])], {
        ...silenced,
        rungs: three,
      }) ?? '',
      /720p 10\.0s fall more than one/,
    );
  });

  it('refuses an empty expectation', () => {
    assert.notEqual(recordingRefusal([], [], { ...expectation, rungs: [] }), null);
  });
});

describe('sessionGrowthRefusal', () => {
  const counts = (entries: [string, number][]) => new Map(entries);

  it('passes a recording that grew by exactly the sessions broadcast, on every rung, from any history', () => {
    assert.equal(
      sessionGrowthRefusal(
        counts([
          ['360p', 7],
          ['1080p', 7],
        ]),
        counts([
          ['360p', 9],
          ['1080p', 9],
        ]),
        2,
      ),
      null,
    );
  });

  it('refuses a rung that kept only its last session, or gained none', () => {
    const refusal = sessionGrowthRefusal(
      counts([
        ['360p', 3],
        ['1080p', 3],
      ]),
      counts([
        ['360p', 5],
        ['1080p', 1],
      ]),
      2,
    );
    assert.match(refusal ?? '', /1080p went from 3 to 1 session\(s\) where 2 were added/);
    assert.match(refusal ?? '', /the rungs disagree/);
  });

  it('refuses a rung whose head stopped being a recording, and an empty baseline', () => {
    assert.match(sessionGrowthRefusal(counts([['360p', 1]]), counts([]), 1) ?? '', /360p holds no finished recording/);
    assert.notEqual(sessionGrowthRefusal(counts([]), counts([['360p', 2]]), 1), null);
  });

  it('counts only finished recordings into a baseline', () => {
    const live = recordingRungOf(rungPlaylistParse(feed('1080p'), rungPlaylist([0, 1, 2])));
    assert.deepEqual([...sessionsByRung([finished('360p', [4, 4]), live])], [['360p', 2]]);
  });
});

describe('uploadsPerRecordingRung', () => {
  it('keys a ladder by rung through each feed stream id', () => {
    const counts = uploadsPerRecordingRung([feed('360p'), feed('1080p')], new Map([['live/stream_360p', 1200]]));
    assert.deepEqual(
      [...counts],
      [
        ['360p', 1200],
        ['1080p', null],
      ],
    );
  });

  it('keys a single rendition by topic, taking the one stream the window holds, as the listing does', () => {
    const single = { rung: null, streamId: null, topic: 'topic-a' };
    const listed = recordingRungOf(rungPlaylistParse(single, gluedRecording([10])));
    const counts = uploadsPerRecordingRung([single], new Map([['live/stream', 10]]));
    assert.equal(counts.get(listed.rung), 10);
    assert.equal(
      uploadsPerRecordingRung(
        [single],
        new Map([
          ['a', 1],
          ['b', 2],
        ]),
      ).get('topic-a'),
      null,
    );
  });
});
