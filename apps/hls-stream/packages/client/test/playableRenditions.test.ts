/**
 * Which rungs of a catalog entry the watch page hands the player.
 *
 * ⛔ A finished ladder can lack a rung: on 2026-09-23 1080p's batch refused its recording and the
 * ladder finished without it. The admin's entry still lists that rung, without an index, over a feed
 * whose last playlist is a live one that will never end, and the player would walk it for as long as
 * the recording was watched.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { Rendition, STREAM_STATUS_LIVE, STREAM_STATUS_VOD } from '../src/types/stream';
import { playableRenditions, recordingOf } from '../src/utils/playableRenditions';

function rung(name: string, recording?: { index: number; duration: number }): Rendition {
  const height = Number.parseInt(name, 10);
  return { name, width: height, height, topic: `topic-${name}`, bandwidth: height, avgBandwidth: height, ...recording };
}

const RECORDED = { index: 7, duration: 12 };

describe('the rungs a viewer is handed', () => {
  it('leaves out a rung with no recording once the ladder is a recording', () => {
    const renditions = [rung('360p', RECORDED), rung('720p', RECORDED), rung('1080p')];

    assert.deepEqual(
      playableRenditions({ state: STREAM_STATUS_VOD, renditions })?.map((rendition) => rendition.name),
      ['360p', '720p'],
    );
  });

  it('hands over every rung of a live ladder, none of which has a recording yet', () => {
    const renditions = [rung('360p'), rung('1080p')];

    assert.deepEqual(playableRenditions({ state: STREAM_STATUS_LIVE, renditions }), renditions);
  });

  it('hands over nothing for an entry that is not a ladder', () => {
    assert.equal(playableRenditions({ state: STREAM_STATUS_VOD }), undefined);
    assert.equal(playableRenditions(undefined), undefined);
  });
});

describe('the recording a viewer is handed', () => {
  it('names a finished entry’s own index', () => {
    assert.deepEqual(recordingOf({ state: STREAM_STATUS_VOD, index: 41 }), { index: 41 });
  });

  it('is a recording without an index too, so its rungs are still read at theirs', () => {
    assert.deepEqual(recordingOf({ state: STREAM_STATUS_VOD }), { index: undefined });
  });

  it('is nothing for a live entry, whatever index it carries, nor for no entry', () => {
    assert.equal(recordingOf({ state: STREAM_STATUS_LIVE, index: 41 }), undefined);
    assert.equal(recordingOf(undefined), undefined);
  });
});
