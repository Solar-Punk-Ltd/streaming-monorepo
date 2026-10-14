/**
 * A restarted stream publishes its live playlist even when its node takes longer than one request's
 * deadline to read where the feed has got to, and a manifest write that ran out of time once is
 * retried with time of its own.
 *
 * ## What happened
 *
 * On 2026-10-14 a broadcast on a stream that had broadcast before published a live playlist for one
 * rung of four, for its whole length. Each rung has to read its feed's head before its first publish,
 * so it continues the feed rather than writing over it, and that read took the rung's node 4.0 s at the
 * median and up to 7.4 s. Two things then kept it from ever answering:
 *
 * 1. Every request carried the pool's 4 s deadline, which was derived from the upload retry windows
 *    and says nothing about a feed lookup.
 * 2. bee-js counts a feed reader's deadline from when the reader is made, and the read made its
 *    reader once and retried it. Every attempt after the first started with its deadline already
 *    spent and failed at once, so the retry window bought nothing, and the next segment started the
 *    same doomed read again.
 *
 * `beePublisherPool.test.ts` pins both bee-js facts against a real socket. The fake node here carries
 * deadlines the same way, through {@link FakeDeadlines}, so these cases exercise the uploader's own
 * reads and writes rather than a fake that cannot run out of time.
 *
 * ## What these deliberately do not cover
 *
 * - **Timings.** The node's answer times are a fraction of a second so the cases stay cheap. Nothing
 *   asserts how long a read took; see the e2e rule in `AGENTS.md`.
 * - **The catalog and the master feed.** They make their writers and readers per attempt for the same
 *   reason, and `beePublisherPool.test.ts` pins why. Their own suites hold what they write.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminApiClient, AdminStateReport, STATE_REPORT_ACCEPTED } from '../src/libs/AdminApiClient.js';
import { AdminSession, MEDIA_TYPE_AUDIO } from '../src/types.js';

import { FakeDeadlines, makeTestOrchestrator } from './helpers/fakes.js';
import { waitFor } from './helpers/waiting.js';

/** A ceiling on a hung wait, not a measurement. Far below the uploader's 15 s windows on purpose. */
const SETTLE_CEILING_MS = 4_000;

/** The pool's deadline in these cases, and how long the node takes to read a feed head: longer. */
const POOL_TIMEOUT_MS = 30;
const HEAD_READ_MS = 80;

const SEGMENT_SECONDS = 2;
const DECLARATION: AdminSession = { id: 'admin-stream-id', topic: 'declared-topic-0002' };
const STREAM_ID = 'audio/declared-restart';

/** The recording an earlier broadcast on this declared topic left at the head of its feed. */
const PREVIOUS_RECORDING = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXTINF:2.000,',
  'segment-a0',
  '#EXTINF:2.000,',
  'segment-a1',
  '#EXT-X-ENDLIST',
  '',
].join('\n');
const PREVIOUS_HEAD_INDEX = 7;

interface ManifestWrite {
  index: number;
  playlist: string;
}

function restartedStream(deadlines: FakeDeadlines, head: { index: number; manifest: string } | null) {
  const writes: ManifestWrite[] = [];
  const uploaded: string[] = [];
  const adminApi = {
    describe: () => 'http://admin.test',
    reportState: async (_id: string, _report: AdminStateReport) => STATE_REPORT_ACCEPTED,
  } as unknown as AdminApiClient;

  const orchestrator = makeTestOrchestrator(
    { adminApi },
    {
      deadlines,
      uploadData: async (_stamp, data) => {
        const label = Buffer.from(data).toString('utf8');
        uploaded.push(label);
        return { reference: { toHex: () => `segment-${label}` } };
      },
      feedHead: () => head,
      uploadPayload: async (index, payload) => {
        writes.push({ index, playlist: String(payload) });
        return { reference: { toHex: () => `soc-${index}` } };
      },
    },
  );

  assert.equal(orchestrator.startStream(STREAM_ID, MEDIA_TYPE_AUDIO, undefined, DECLARATION), true);
  return {
    writes,
    segment: async (label: string, index: number) => {
      assert.deepEqual(orchestrator.handleSegment(STREAM_ID, index, SEGMENT_SECONDS, Buffer.from(label)), {
        accepted: true,
      });
      await waitFor(() => uploaded.includes(label), SETTLE_CEILING_MS);
    },
  };
}

describe('a node slower than one request’s deadline', () => {
  it('still lets a restarted stream read where its feed has got to, and continue it', async () => {
    const stream = restartedStream(
      { poolTimeoutMs: POOL_TIMEOUT_MS, headReadMs: HEAD_READ_MS },
      { index: PREVIOUS_HEAD_INDEX, manifest: PREVIOUS_RECORDING },
    );

    await stream.segment('b0', 0);
    await waitFor(() => stream.writes.some((write) => write.playlist.includes('segment-b0')), SETTLE_CEILING_MS);

    const first = stream.writes.find((write) => write.playlist.includes('segment-b0'))!;
    assert.equal(first.index, PREVIOUS_HEAD_INDEX + 1, 'the live playlist did not continue the feed');
  });

  it('retries a manifest write that ran out of time with a deadline of its own', async () => {
    const stream = restartedStream(
      { poolTimeoutMs: POOL_TIMEOUT_MS, firstWriteFailsAfterMs: POOL_TIMEOUT_MS * 2 },
      null,
    );

    await stream.segment('c0', 0);
    await waitFor(() => stream.writes.some((write) => write.playlist.includes('segment-c0')), SETTLE_CEILING_MS);

    assert.equal(stream.writes[0].index, 0, 'a declared topic nothing was written on starts at index 0');
  });
});
