import {
  addingStreamToList,
  encoderReturned,
  ladderFinalized,
  rungAnnounced,
  segmentUploaded,
  updatingStreamToVod,
} from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  continuationRefusal,
  everyStreamDelivered,
  publisherEnding,
  requirePublishing,
  secondsToFirstSegment,
} from '../src/harness/ingest.js';
import { StopWaiting } from '../src/harness/wait.js';

/** `Logger`'s text format, which every line below is written in. */
function textLine(message: string): string {
  return `[2026-10-03T09:14:05.123Z] [LOG] - ${message}`;
}

function log(...messages: string[]): string {
  return messages.map(textLine).join('\n');
}

const TOPIC = 'a'.repeat(64);
const OTHER_TOPIC = 'b'.repeat(64);
const LADDER = 'c'.repeat(64);
const RUNG_TOPICS = ['d', 'e', 'f', '1'].map((hex) => hex.repeat(64));
const RUNGS = ['360p', '480p', '720p', '1080p'];

/** The entry `StreamUploader.notifyStart` and the finalize log, in the shape they log it. */
function entry(topic: string, state: string): string {
  return JSON.stringify({ title: 'a broadcast', owner: '0'.repeat(40), topic, state, mediatype: 'video' });
}

const UPLOADED = (streamId: string, index: number) => segmentUploaded(streamId, index, `${index}`.padStart(64, '0'));
const RETURNED = (sequence: number) =>
  encoderReturned(sequence, '2026-10-03T09:14:00.000Z', '2026-10-03T09:14:09.000Z');

describe('whether every stream of a broadcast has delivered', () => {
  const twoStreams = log(
    UPLOADED('live/stream_360p', 0),
    UPLOADED('live/stream_720p', 0),
    UPLOADED('live/stream_360p', 1),
    UPLOADED('live/stream_720p', 1),
  );

  it('answers yes once each stream reached the count', () => {
    assert.equal(everyStreamDelivered(twoStreams, 2, 2), true);
  });

  it('answers no while one stream is short, however far ahead the other is', () => {
    assert.equal(everyStreamDelivered(`${twoStreams}\n${textLine(UPLOADED('live/stream_360p', 2))}`, 2, 3), false);
  });

  it('answers no for a log with fewer streams in it than the broadcast has', () => {
    assert.equal(everyStreamDelivered(twoStreams, 4, 1), false);
  });
});

describe('how long the first segment took, read off the host’s own clock', () => {
  const stamped = (iso: string, message: string) => `[${iso}] [LOG] - ${message}`;

  it('counts from the instant given to the first upload after it', () => {
    const text = [
      stamped('2026-10-03T09:14:07.500Z', 'Some other line'),
      stamped('2026-10-03T09:14:09.250Z', UPLOADED('live/stream', 7)),
      stamped('2026-10-03T09:14:11.000Z', UPLOADED('live/stream', 8)),
    ].join('\n');

    assert.equal(secondsToFirstSegment(text, '2026-10-03T09:14:05Z'), 4.25);
  });

  it('has no reading when nothing was uploaded', () => {
    assert.equal(
      secondsToFirstSegment(stamped('2026-10-03T09:14:07.500Z', 'Some other line'), '2026-10-03T09:14:05Z'),
      null,
    );
  });
});

describe('how a publisher ended', () => {
  const key = '2d1e344ecb833667c936399866349fbc';
  const ended = {
    exit: () => ({ code: 1, signal: null }),
    stderr: () =>
      `[flv @ 0x1] Failed to update header\nError writing trailer of rtmp://203.0.113.10:1935/video/demo?key=${key}: ` +
      'Broken pipe\n',
  };

  /** ffmpeg quotes the URL it dialled in its own errors, and the URL carries the publish key. */
  it('quotes its last words with the publish key cut out', () => {
    const said = publisherEnding(ended);

    assert.equal(said.includes(key), false, `the key survived: ${said}`);
    assert.match(said, /^exited with 1, saying: .*Broken pipe$/);
  });

  it('says a publisher is still running when it is', () => {
    assert.equal(publisherEnding({ exit: () => null, stderr: () => '' }), 'is still running');
  });

  it('stops a wait at once when the publisher it waits on has ended, and not before', () => {
    assert.throws(() => requirePublishing(ended, 'the reconnecting publisher'), StopWaiting);
    assert.doesNotThrow(() => requirePublishing({ exit: () => null, stderr: () => '' }, 'the live publisher'));
  });
});

describe('whether a return continued the broadcast it left', () => {
  const single = new Set([TOPIC]);
  const singleBroadcast = log(addingStreamToList(entry(TOPIC, 'live')), UPLOADED('live/stream', 0));

  it('reads one seam and nothing else as the same broadcast continuing', () => {
    assert.equal(continuationRefusal(singleBroadcast, log(RETURNED(3)), single, 1), null);
  });

  it('refuses a return that announced a session of its own', () => {
    const sinceDrop = log(addingStreamToList(entry(OTHER_TOPIC, 'live')), RETURNED(0));

    assert.match(continuationRefusal(singleBroadcast, sinceDrop, single, 1) ?? '', /new session topic/);
  });

  it('refuses a broadcast that was finalized, whatever the seams say', () => {
    const finalized = `${singleBroadcast}\n${textLine(updatingStreamToVod(entry(TOPIC, 'vod')))}`;

    assert.match(continuationRefusal(finalized, log(RETURNED(3)), single, 1) ?? '', /finalized into a recording/);
  });

  it('ignores a neighbouring broadcast’s finalize trailing into the window', () => {
    const neighbour = `${singleBroadcast}\n${textLine(updatingStreamToVod(entry(OTHER_TOPIC, 'vod')))}`;

    assert.equal(continuationRefusal(neighbour, log(RETURNED(3)), single, 1), null);
  });

  it('refuses a return that placed no seam, and one that placed two', () => {
    assert.match(continuationRefusal(singleBroadcast, log(), single, 1) ?? '', /placed 0 seam/);
    assert.match(continuationRefusal(singleBroadcast, log(RETURNED(3), RETURNED(4)), single, 1) ?? '', /placed 2 seam/);
  });

  describe('on a ladder', () => {
    const rungTopics = new Set(RUNG_TOPICS);
    const ladderBroadcast = log(
      ...RUNGS.map((rung, at) => rungAnnounced(`live/stream_${rung}`, rung, LADDER, RUNG_TOPICS[at])),
    );

    it('owes one seam per rung', () => {
      const allFour = log(...RUNGS.map((_rung, at) => RETURNED(10 + at)));

      assert.equal(continuationRefusal(ladderBroadcast, allFour, rungTopics, RUNGS.length), null);
      assert.match(continuationRefusal(ladderBroadcast, log(RETURNED(10)), rungTopics, RUNGS.length) ?? '', /placed 1/);
    });

    /** A ladder's finalize names its group, and only the rung announces at the start tie the group to its topics. */
    it('refuses a ladder finalized after the drop, read through the announces before it', () => {
      const finalized = `${ladderBroadcast}\n${textLine(ladderFinalized(LADDER))}`;

      assert.match(continuationRefusal(finalized, log(), rungTopics, RUNGS.length) ?? '', /finalized/);
    });
  });
});
