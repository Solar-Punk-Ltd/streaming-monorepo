/**
 * A broadcast's recording is published at its stop even when writing it takes longer than one
 * request's deadline, because a recording is larger than a chunk and its write grows with it.
 *
 * ## What went wrong
 *
 * Every manifest goes out through one writer, and that writer carried the pool's 4 s deadline. A live
 * playlist is capped at `LIVE_WINDOW_MAX_BYTES`, one chunk, so it is one request and fits. The
 * recording names every segment of the broadcast, about 9 KB a minute at one second segments, so past
 * the first minute bee-js writes it as a byte upload of every chunk, pushed synchronously, then a read
 * of the root and the SOC write, all under the one deadline taken when the writer was made. On a long
 * broadcast every attempt runs out, the finalize throws `Failed to upload VOD manifest`, and every
 * recovery boot repeats it.
 *
 * The fake node here takes time per chunk written, through {@link FakeDeadlines}, and the pool's
 * deadline is shorter than two chunks, so a live playlist lands and a recording only lands when its
 * write is given a deadline sized to what it carries.
 *
 * ## What this deliberately does not cover
 *
 * Timings. The node's answer times are a few milliseconds so the case stays cheap, and nothing asserts
 * how long a write took. See the e2e rule in `apps/hls-stream/AGENTS.md`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LIVE_WINDOW_MAX_BYTES } from '../src/libs/ManifestManager.js';
import { MEDIA_TYPE_VIDEO, STREAM_LIFECYCLE_FAILED } from '../src/types.js';

import { makeTestOrchestrator } from './helpers/fakes.js';
import { waitFor } from './helpers/waiting.js';

/** A ceiling on a hung wait, not a measurement. */
const SETTLE_CEILING_MS = 10_000;

/** The pool's deadline, and what one chunk costs this node to write: a second chunk runs past it. */
const POOL_TIMEOUT_MS = 30;
const WRITE_MS_PER_CHUNK = 20;

const STREAM_ID = 'live/long-broadcast';

/** Enough two-second segments, each named by a full reference, that the recording outgrows a chunk. */
const SEGMENT_COUNT = 48;

const VOD_MARKER = '#EXT-X-PLAYLIST-TYPE:VOD';

/** A reference shaped like bee's, 64 hex characters, so the recording grows as a real one does. */
function referenceFor(label: string): string {
  return Buffer.from(label).toString('hex').padStart(64, '0');
}

describe('a recording larger than one chunk', () => {
  it('is published at the stop, on a node slower than one request’s deadline per chunk', async () => {
    const writes: string[] = [];
    const uploaded: string[] = [];
    const orch = makeTestOrchestrator(
      {},
      {
        deadlines: { poolTimeoutMs: POOL_TIMEOUT_MS, writeMsPerChunk: WRITE_MS_PER_CHUNK },
        uploadData: async (_stamp, data) => {
          const label = Buffer.from(data).toString('utf8');
          uploaded.push(label);
          return { reference: { toHex: () => referenceFor(label) } };
        },
        uploadPayload: async (index, payload) => {
          writes.push(String(payload));
          return { reference: { toHex: () => `soc-${index}` } };
        },
      },
    );

    orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    for (let index = 0; index < SEGMENT_COUNT; index++) {
      orch.handleSegment(STREAM_ID, index, 2, Buffer.from(`s${index}`));
    }
    await waitFor(() => uploaded.length === SEGMENT_COUNT, SETTLE_CEILING_MS);
    await waitFor(() => writes.length > 0, SETTLE_CEILING_MS);

    await orch.stopStream(STREAM_ID);

    const recording = writes.find((write) => write.includes(VOD_MARKER));
    assert.ok(recording !== undefined, 'the recording never landed in the feed');
    assert.ok(
      Buffer.byteLength(recording, 'utf-8') > LIVE_WINDOW_MAX_BYTES,
      'the recording fits one chunk, so this case does not exercise a multi-chunk write',
    );
    assert.notEqual(orch.getStreamStatus(STREAM_ID).state, STREAM_LIFECYCLE_FAILED, 'the finalize failed');

    await orch.cleanup();
  });
});
