/**
 * The uploader tells the marker writer where each rung's feed stands, and when a ladder is over.
 *
 * Driven through the orchestrator, because the two facts come from different places: a rung's newest
 * index is known only to its own session, after its manifest landed, and the end of a ladder is known
 * only to the orchestrator, once its last rung is released.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AbrLadder, DEFAULT_LADDER_SPEC } from '../src/libs/AbrLadder.js';
import { LadderMarkerSink } from '../src/libs/LadderMarkerWriter.js';
import { RememberedLadder } from '../src/libs/LadderGroupStore.js';
import { ServiceMetrics } from '../src/libs/ServiceMetrics.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { MEDIA_TYPE_VIDEO } from '../src/types.js';
import { rungTopicFor } from '../src/utils/rungTopic.js';

import { makeTestOrchestrator } from './helpers/fakes.js';
import { FRAME_TICKS, videoSegment } from './helpers/transportStream.js';
import { waitFor } from './helpers/waiting.js';

const BASE = 'live/stream';
const RUNG_360P = `${BASE}_360p`;
const SINGLE = 'live/single';
const SETTLE_CEILING_MS = 4_000;
const FRAMES = 30;

interface Published {
  group: string;
  rungTopic: string;
  index: number;
}

function recordingSink(): LadderMarkerSink & { published: Published[]; ended: string[] } {
  const published: Published[] = [];
  const ended: string[] = [];
  return {
    published,
    ended,
    recordPublished: (group, rungTopic, index) => published.push({ group, rungTopic, index }),
    endLadder: (group) => ended.push(group),
  };
}

/** Reaches the ladder maps directly, for the reason `StreamOrchestrator.test.ts` gives: the group id has no behavioural signal to observe. */
function groupOf(orch: StreamOrchestrator): string | undefined {
  return (orch as unknown as { ladderGroups: Map<string, RememberedLadder> }).ladderGroups.get(BASE)?.group;
}

function feed(orch: StreamOrchestrator, streamId: string, from: number, count: number): void {
  for (let i = from; i < from + count; i++) {
    orch.handleSegment(streamId, i, 1, videoSegment(FRAMES, FRAME_TICKS * FRAMES * i));
  }
}

describe('ladder markers wired into the uploader', () => {
  it("reports each rung's published manifest index, under the ladder's group and the rung's own topic", async () => {
    const sink = recordingSink();
    const socIndexes: number[] = [];
    const orch = makeTestOrchestrator(
      { ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC), ladderMarkers: sink },
      {
        uploadPayload: async (index) => {
          socIndexes.push(index);
          return { reference: { toHex: () => `soc${index}` } };
        },
      },
    );

    orch.startStream(RUNG_360P, MEDIA_TYPE_VIDEO);
    feed(orch, RUNG_360P, 0, 3);
    await waitFor(() => sink.published.length >= 2, SETTLE_CEILING_MS);

    const group = groupOf(orch);
    assert.ok(group, 'the rung joined a ladder');
    for (const report of sink.published) {
      assert.equal(report.group, group);
      assert.equal(report.rungTopic, rungTopicFor(group, '360p'));
    }
    assert.deepEqual(
      sink.published.map((report) => report.index),
      socIndexes.slice(0, sink.published.length),
      'every report names an index a manifest actually landed at',
    );

    await orch.stopStream(RUNG_360P);
    await waitFor(() => sink.ended.length > 0, SETTLE_CEILING_MS);
    assert.deepEqual(sink.ended, [group], 'the ladder ends once its last rung is released');
  });

  it('reports nothing for a stream that is not a rung of a ladder', async () => {
    const sink = recordingSink();
    let manifests = 0;
    const orch = makeTestOrchestrator(
      { ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC), ladderMarkers: sink },
      {
        uploadPayload: async (index) => {
          manifests += 1;
          return { reference: { toHex: () => `soc${index}` } };
        },
      },
    );

    orch.startStream(SINGLE, MEDIA_TYPE_VIDEO);
    feed(orch, SINGLE, 0, 3);
    await waitFor(() => manifests >= 2, SETTLE_CEILING_MS);
    await orch.stopStream(SINGLE);

    assert.deepEqual(sink.published, []);
    assert.deepEqual(sink.ended, []);
  });

  it('serves the counters of the metrics it was handed, which the marker writer shares', () => {
    const metrics = new ServiceMetrics();
    const orch = makeTestOrchestrator({ metrics });

    metrics.recordLadderMarkerWritten();
    metrics.recordLadderMarkerFailed();
    metrics.recordLadderMarkerWritten();

    const snapshot = orch.getMetricsSnapshot();
    assert.equal(snapshot.ladderMarkersWrittenTotal, 2);
    assert.equal(snapshot.ladderMarkersFailedTotal, 1);
  });
});
