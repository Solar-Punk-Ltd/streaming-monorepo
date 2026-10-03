import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PUBLISHER_GOP_SECONDS, publisherArgs } from '../src/harness/publisher.js';
import { INGEST_RTMP, INGEST_SRT } from '../src/ingestProtocol.js';

const SRT_URL = 'srt://203.0.113.10:10061?streamid=#!::r=video/demo,m=publish';
const RTMP_URL = 'rtmp://203.0.113.10:10062/video/demo';

/** The value that follows `flag` in an argument list, or undefined when the flag is not there. */
function valueOf(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/**
 * The encoder the harness publishes with, over either protocol.
 *
 * Everything about the picture is the same over both, because the protocol is the variable a suite run over RTMP is
 * asking about and nothing else may move with it. Only the container changes: SRS takes MPEG-TS inside SRT and FLV
 * inside RTMP.
 */
describe('the publisher’s encoder', () => {
  it('sends MPEG-TS over SRT, to the URL it was given, last', () => {
    const args = publisherArgs(SRT_URL, INGEST_SRT, 30);

    assert.equal(valueOf(args, '-f'), 'lavfi', 'the inputs come first');
    assert.equal(args.at(-1), SRT_URL);
    assert.equal(args[args.lastIndexOf('-f') + 1], 'mpegts');
  });

  it('sends FLV over RTMP, to the URL it was given, last', () => {
    const args = publisherArgs(RTMP_URL, INGEST_RTMP, 30);

    assert.equal(args.at(-1), RTMP_URL);
    assert.equal(args[args.lastIndexOf('-f') + 1], 'flv');
  });

  it('encodes the same picture over both, so the protocol is the only thing that differs', () => {
    const encodeOf = (args: readonly string[]) => args.slice(0, args.lastIndexOf('-f'));

    assert.deepEqual(
      encodeOf(publisherArgs(RTMP_URL, INGEST_RTMP, 30)),
      encodeOf(publisherArgs(SRT_URL, INGEST_SRT, 30)),
    );
  });

  it('places a keyframe every PUBLISHER_GOP_SECONDS at the frame rate it was given', () => {
    assert.equal(valueOf(publisherArgs(RTMP_URL, INGEST_RTMP, 25), '-g'), String(25 * PUBLISHER_GOP_SECONDS));
  });
});
