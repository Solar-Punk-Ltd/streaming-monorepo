import { Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { RungFeedReader } from '../../src/components/SwarmHlsPlayer/rungFeedReader.js';
import type { PathResponse } from '../helpers/playerReader';
import { readerOverPaths } from '../helpers/playerReader.js';

const OWNER = 'a1'.repeat(20);
const TOPIC = Topic.fromString('rung-feed-reader-test');

function readerAnswering(text: string): RungFeedReader {
  const answerPath = async (): Promise<PathResponse> => ({ ok: true, status: 200, headers: new Headers(), text });
  return new RungFeedReader(readerOverPaths(answerPath), OWNER, TOPIC, () => 0);
}

describe('reading one slot of a quality', () => {
  it('takes a playlist as the slot', async () => {
    const read = await readerAnswering('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg-1\n').read(4);

    assert.equal(read.found, true);
  });

  it('takes a 200 whose body is not a playlist as no slot, as a captive portal or a stray chunk answers', async () => {
    const read = await readerAnswering('<!doctype html><title>Sign in to the network</title>').read(4);

    assert.deepEqual(read, { found: false });
  });

  /**
   * The uploader's target duration is the longest segment so far rounded up, and it never comes down,
   * so a half-second stage declares 1 and a two-second one 3 after one overshoot. The cadence a new
   * playlist appears at is what the segments themselves last.
   */
  it('carries the segment length its playlist names in EXTINF, not the target duration', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:1',
      '#EXTINF:0.5,',
      's1',
      '#EXTINF:0.5,',
      's2',
      '#EXTINF:0.433,',
      's3',
    ];
    const read = await readerAnswering(playlist.join('\n')).read(4);

    assert.equal(read.found && read.entry.segmentMs, 500);
  });

  it('falls back to the target duration when no segment names a usable length', async () => {
    const read = await readerAnswering('#EXTM3U\n#EXT-X-TARGETDURATION:2\n').read(4);

    assert.equal(read.found && read.entry.segmentMs, 2_000);
  });

  it('takes a playlist that names no segment length at all as no slot, since nothing could follow it', async () => {
    const read = await readerAnswering('#EXTM3U\n#EXT-X-VERSION:3\n').read(4);

    assert.deepEqual(read, { found: false });
  });
});
