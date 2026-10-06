import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasRecording, isFinishedLadder, recordedRungs } from '../src/libs/LadderCompletion.js';
import { buildLadderEntry, LadderIdentity, StreamEntry } from '../src/libs/StreamCatalog.js';
import { MEDIA_TYPE_VIDEO, Rendition } from '../src/types.js';

/**
 * A recording is named by its reference and nothing else. A feed index, which uploaders on feeds once wrote on a rung
 * or an entry, is no recording now: a rung holding only one has not finished, and no entry this uploader writes
 * carries one.
 */

const RECORDING = 'ab'.repeat(32);

const identity: LadderIdentity = { title: 'title', owner: 'abcd', group: 'group-1', mediatype: MEDIA_TYPE_VIDEO };

const rung = (name: string, height: number): Rendition => ({
  name,
  width: (height * 16) / 9,
  height,
  topic: `group-1-${name}`,
  bandwidth: height * 5000,
  avgBandwidth: height * 4000,
});

/** A rung an uploader on feeds finished, as an older list version still holds it. */
const indexedRung = (name: string, height: number): Rendition =>
  ({ ...rung(name, height), index: 7, duration: 61 }) as Rendition;

describe('a feed index is no recording', () => {
  it('does not count as one, alone on a rung', () => {
    assert.equal(hasRecording(indexedRung('360p', 360)), false);
    assert.deepEqual(recordedRungs([indexedRung('360p', 360)]), []);
    assert.equal(isFinishedLadder([indexedRung('360p', 360)], new Set()), false);
  });

  it('leaves a ladder held only by indexes live, and the entry names no index', () => {
    const previous: StreamEntry[] = [
      {
        title: 'title',
        owner: 'abcd',
        topic: 'group-1-360p',
        state: 'vod',
        mediatype: MEDIA_TYPE_VIDEO,
        timestamp: 1,
        group: 'group-1',
        renditions: [indexedRung('360p', 360)],
      },
    ];

    const entry = buildLadderEntry(identity, previous, rung('360p', 360));

    assert.equal(entry.state, 'live');
    assert.equal('index' in entry, false);
    assert.equal(
      entry.renditions?.some((r) => 'index' in r),
      false,
      'a re-announce must not carry an old index forward',
    );
  });

  it('names the recording of a ladder finished by reference, and nothing else', () => {
    const finished = buildLadderEntry(identity, [], { ...rung('360p', 360), recording: RECORDING, duration: 61 });

    assert.equal(finished.state, 'vod');
    assert.equal(finished.recording, RECORDING);
    assert.equal('index' in finished, false);
  });
});
