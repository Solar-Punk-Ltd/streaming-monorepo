import { manifestUploaded, rungAnnounced, segmentUploaded } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { ROOT_DIR } from '../src/config.js';
import { rungPlaylistParse } from '../src/harness/manifestContractLive.js';
import {
  crashRecoveredStreams,
  everyRungPublishedAtLeast,
  feedIndexFromHeaders,
  headAdvanced,
  headAdvanceRefusal,
  manifestPublishesByRung,
  missingTopicResumes,
  publishShortfall,
  reapedAfterDisconnect,
  rungMetricPairing,
  rungMetricRefusal,
  segmentUploadsByRung,
  socIndexRefusal,
  staleManifestWarnings,
  staleWarningRefusal,
  topicResumes,
} from '../src/harness/rungPublishing.js';

import { GATEWAY_ERROR_ENVELOPE, rungPlaylist } from './helpers/rungPlaylistFixtures.js';

/**
 * The readings that would have gone red on 2026-10-14, when a re-broadcast left rungs uploading segments and publishing
 * no playlist while every suite passed.
 *
 * ⛔ The announce, segment and manifest lines are built with the composers the uploader logs through. The stale, resume
 * and recovery lines are typed out here because the uploader writes them as raw text. `test/logLevel.test.ts` holds each
 * of those against the uploader's own source, so a reword there fails a test rather than leaving these fixtures agreeing
 * with a parser that matches nothing on a real log.
 */

function textLine(message: string): string {
  return `[2026-10-14T09:14:05.123Z] [LOG] - ${message}`;
}

function jsonLine(message: string): string {
  return JSON.stringify({ ts: '2026-10-14T09:14:05.123Z', level: 'warn', msg: message });
}

const RUNGS = ['360p', '1080p'] as const;
const streamOf = (rung: string): string => `live/stream_${rung}`;
const topicOf = (rung: string): string => `group-a-${rung}`;

function announces(rungs: readonly string[] = RUNGS): string[] {
  return rungs.map((rung) => textLine(rungAnnounced(streamOf(rung), rung, 'group-a', topicOf(rung))));
}

function stale(streamId: string, run: number): string {
  return `Live manifest for stream ${streamId} is stale: ${run} consecutive publish failure(s)`;
}

function resume(streamId: string, index: number, sequence: number): string {
  return (
    `[StreamUploader] Stream ${streamId} resumes its topic at SOC index ${index}, numbering its playlist from media ` +
    `sequence ${sequence}, so this session continues the feed rather than writing over the last one`
  );
}

describe('manifestPublishesByRung', () => {
  it('counts publishes per rung name, and a rung that only uploads segments counts none', () => {
    const log = [
      ...announces(),
      textLine(segmentUploaded(streamOf('360p'), 10, 'a'.repeat(64))),
      textLine(segmentUploaded(streamOf('1080p'), 10, 'b'.repeat(64))),
      textLine(manifestUploaded(streamOf('360p'), 0)),
      textLine(segmentUploaded(streamOf('1080p'), 11, 'c'.repeat(64))),
      textLine(manifestUploaded(streamOf('360p'), 1)),
    ].join('\n');

    assert.deepEqual([...manifestPublishesByRung(log)], [['360p', 2]]);
    assert.deepEqual(
      new Map(segmentUploadsByRung(log)),
      new Map([
        ['360p', 1],
        ['1080p', 2],
      ]),
    );
    assert.equal(everyRungPublishedAtLeast(log, RUNGS, 1), false, 'the 1080p rung published no playlist');
    assert.equal(everyRungPublishedAtLeast(log, ['360p'], 2), true);
  });

  it('keys a single rendition by its stream id, since it announces no rung', () => {
    const log = [textLine(manifestUploaded('live/stream', 0)), textLine(manifestUploaded('live/stream', 1))].join('\n');
    assert.deepEqual([...manifestPublishesByRung(log)], [['live/stream', 2]]);
  });
});

describe('publishShortfall', () => {
  it('names every rung below the bar with every count', () => {
    const refusal = publishShortfall(new Map([['360p', 12]]), RUNGS, 10);
    assert.match(refusal ?? '', /^1080p published fewer than 10/);
    assert.match(refusal ?? '', /360p 12, 1080p 0/);
  });

  it('refuses an empty expectation instead of passing on a broadcast that published nothing', () => {
    assert.notEqual(publishShortfall(new Map(), [], 1), null);
  });

  it('passes when every rung reached the bar', () => {
    assert.equal(
      publishShortfall(
        new Map([
          ['360p', 3],
          ['1080p', 3],
        ]),
        RUNGS,
        3,
      ),
      null,
    );
  });
});

describe('staleManifestWarnings', () => {
  it('reads the warning in both log formats, with the run length', () => {
    const log = [textLine(stale(streamOf('1080p'), 1)), jsonLine(stale(streamOf('1080p'), 2))].join('\n');
    assert.deepEqual(staleManifestWarnings(log), [
      { streamId: streamOf('1080p'), consecutive: 1 },
      { streamId: streamOf('1080p'), consecutive: 2 },
    ]);
  });

  it('refuses any warning and names the worst run per stream', () => {
    const refusal = staleWarningRefusal([
      { streamId: 'a', consecutive: 1 },
      { streamId: 'a', consecutive: 4 },
    ]);
    assert.match(refusal ?? '', /2 time\(s\)/);
    assert.match(refusal ?? '', /a up to 4 in a row/);
    assert.equal(staleWarningRefusal([]), null);
  });

  it('would notice: a clean log reads no warning', () => {
    assert.deepEqual(staleManifestWarnings(announces().join('\n')), []);
  });
});

describe('topic resumes', () => {
  it('reads the stream, the SOC index and the media sequence a resumed session continues from', () => {
    assert.deepEqual(topicResumes(textLine(resume(streamOf('1080p'), 41, 120))), [
      { streamId: streamOf('1080p'), socIndex: 41, mediaSequence: 120 },
    ]);
  });

  it('names a rung that reopened a topic an earlier session announced and never read its head', () => {
    const before = announces().join('\n');
    const after = [...announces(), textLine(resume(streamOf('360p'), 7, 30))].join('\n');
    assert.deepEqual(missingTopicResumes(before, after), ['1080p']);
  });

  it('leaves out a session rebuilt from a recovery entry, which is right not to read the head', () => {
    const before = announces().join('\n');
    const after = [
      ...announces(),
      textLine(resume(streamOf('360p'), 7, 30)),
      textLine(
        `[StreamOrchestrator] Recovered stream ${streamOf('1080p')} with 12 segments, waiting 60000ms for engine reconnect`,
      ),
    ].join('\n');
    assert.deepEqual(crashRecoveredStreams(after), [streamOf('1080p')]);
    assert.deepEqual(missingTopicResumes(before, after), []);
  });

  it('asks nothing of a fresh topic, which has no head to read', () => {
    assert.deepEqual(missingTopicResumes('', announces().join('\n')), []);
  });
});

describe('headAdvanceRefusal', () => {
  const feed = (rung: string) => ({ rung, streamId: streamOf(rung), topic: topicOf(rung) });
  const read = (rung: string, sequences: number[]) => rungPlaylistParse(feed(rung), rungPlaylist(sequences));

  it('passes when every rung head ended further on at the second read', () => {
    const first = [read('360p', [0, 1, 2]), read('1080p', [0, 1, 2])];
    const second = [read('1080p', [1, 2, 3, 4]), read('360p', [2, 3, 4])];
    assert.equal(headAdvanceRefusal(first, second), null);
  });

  it('refuses the rung whose head stood still, which is the re-broadcast defect seen from a viewer', () => {
    const first = [read('360p', [0, 1, 2]), read('1080p', [5, 6, 7])];
    const second = [read('360p', [1, 2, 3]), read('1080p', [5, 6, 7])];
    const refusal = headAdvanceRefusal(first, second);
    assert.match(refusal ?? '', /^1 of 2 rung playlist head/);
    assert.match(refusal ?? '', /1080p went from media sequence 5 with 3 segment\(s\), ending at 7/);
  });

  it('counts a window that slid without growing as moving, since its last sequence moved', () => {
    assert.equal(headAdvanced(read('360p', [10, 11, 12]), read('360p', [11, 12, 13])), true);
  });

  it('never reads an unreadable feed as having moved', () => {
    const unreadable = rungPlaylistParse(feed('360p'), GATEWAY_ERROR_ENVELOPE);
    assert.equal(headAdvanced(unreadable, read('360p', [0, 1])), false);
    assert.match(headAdvanceRefusal([read('360p', [0])], [unreadable]) ?? '', /unreadable/);
  });

  it('refuses a reading of nothing, so a check never made cannot pass', () => {
    assert.notEqual(headAdvanceRefusal([], []), null);
  });
});

type RenderMetrics = (snapshot: unknown) => string;

async function loadRenderer(): Promise<RenderMetrics> {
  const path = join(ROOT_DIR, 'packages', 'stream-uploader', 'src', 'utils', 'metricsFormat.ts');
  const loaded = (await import(pathToFileURL(path).href)) as { renderPrometheusMetrics: RenderMetrics };
  return loaded.renderPrometheusMetrics;
}

function exposition(render: RenderMetrics, byRung: Record<string, number>, failures: number): string {
  return render({
    segmentsUploadedTotal: Object.values(byRung).reduce((total, count) => total + count, 0),
    segmentsUploadedByRung: byRung,
    segmentsDroppedTotal: 0,
    segmentsDroppedByRung: {},
    segmentsLostTotal: 0,
    segmentsSkippedTotal: 0,
    openingSegmentsWithheldTotal: 0,
    segmentsNeverNamedTotal: 0,
    manifestPublishFailuresTotal: failures,
    streamsFinalizedTotal: 0,
    streamsFailedTotal: 0,
    streamsReapedTotal: 0,
    segmentDurationsUnreadTotal: 0,
    authRejectionsTotal: 0,
    takeoversRefusedTotal: 0,
    lastSegmentAt: null,
    activeStreams: 1,
    queueDepth: 0,
    queueBacklogSeconds: 0,
  });
}

describe('rungMetricPairing, read off what the uploader actually renders', () => {
  it('pairs each rung upload counter movement with the playlists the log says it published', async () => {
    const render = await loadRenderer();
    const before = exposition(render, { '360p': 100, '1080p': 100 }, 2);
    const after = exposition(render, { '360p': 120, '1080p': 120 }, 2);
    const pairing = rungMetricPairing(before, after, new Map([['360p', 20]]));

    assert.deepEqual(
      new Map(pairing.rows.map((row) => [row.rung, [row.segmentsUploaded, row.playlistsPublished]])),
      new Map([
        ['360p', [20, 20]],
        ['1080p', [20, 0]],
      ]),
    );
    assert.equal(pairing.manifestFailures, 0);
    assert.match(rungMetricRefusal(pairing) ?? '', /1080p uploaded 20 segment\(s\) and published no playlist/);
  });

  it('refuses a failure counter that moved, and passes a pairing where every rung published', async () => {
    const render = await loadRenderer();
    const before = exposition(render, { '360p': 0 }, 0);
    assert.match(
      rungMetricRefusal(rungMetricPairing(before, exposition(render, { '360p': 5 }, 3), new Map([['360p', 5]]))) ?? '',
      /moved by 3/,
    );
    assert.equal(
      rungMetricRefusal(rungMetricPairing(before, exposition(render, { '360p': 5 }, 0), new Map([['360p', 5]]))),
      null,
    );
  });

  it('refuses a scrape that carried no rung at all', () => {
    assert.match(
      rungMetricRefusal(rungMetricPairing('', '', new Map())) ?? '',
      /no swarm_hls_rung_segments_uploaded_total/,
    );
  });
});

describe('socIndexRefusal', () => {
  const before = [
    ...announces(),
    textLine(manifestUploaded(streamOf('360p'), 40)),
    textLine(manifestUploaded(streamOf('1080p'), 40)),
  ].join('\n');

  it('passes a restart whose every publish continues above where the feed stood, without announcing again', () => {
    const after = [textLine(manifestUploaded(streamOf('360p'), 41)), textLine(manifestUploaded(streamOf('1080p'), 41))];
    assert.equal(socIndexRefusal(before, after.join('\n'), RUNGS), null);
  });

  it('refuses a rung that started again at 0 or wrote over its own head', () => {
    const after = [textLine(manifestUploaded(streamOf('360p'), 0)), textLine(manifestUploaded(streamOf('1080p'), 40))];
    const refusal = socIndexRefusal(before, after.join('\n'), RUNGS);
    assert.match(refusal ?? '', /360p wrote SOC index 0 at or below the 40/);
    assert.match(refusal ?? '', /1080p wrote SOC index 40 at or below the 40/);
  });

  it('refuses a rung that published nothing before, whose feed position is unknown', () => {
    assert.match(socIndexRefusal(announces().join('\n'), '', ['360p']) ?? '', /published no live playlist before/);
  });
});

describe('feedIndexFromHeaders', () => {
  it('reads the index bee resolved a feed at, in hex', () => {
    assert.equal(feedIndexFromHeaders('HTTP/1.1 200 OK\r\nSwarm-Feed-Index: 000000000000002a\r\n\r\n'), 42);
  });

  it('answers null for a feed with nothing on it', () => {
    assert.equal(feedIndexFromHeaders('HTTP/1.1 404 Not Found\r\n\r\n'), null);
  });
});

describe('reapedAfterDisconnect', () => {
  it('reads the stream whose reconnect window ran out', () => {
    const log = textLine(
      `[StreamOrchestrator] The encoder feeding ${streamOf('1080p')} left and did not come back within the 60s ` +
        'reconnect window, so its broadcast ends here and is finalized as a VOD',
    );
    assert.deepEqual(reapedAfterDisconnect(log), [streamOf('1080p')]);
    assert.deepEqual(reapedAfterDisconnect(announces().join('\n')), []);
  });
});
