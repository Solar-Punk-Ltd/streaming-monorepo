/**
 * A live segment hls.js could not load used to end one of two ways: hls.js gave it up as a gap it
 * forgot on the next reload, or, at the live edge with its retries spent, a fatal error the player
 * answered by restarting. The player now marks it `#EXT-X-GAP` in the playlist it serves hls.js and
 * plays past it, within a budget, and leaves anything older than the newest few segments alone.
 */

import assert from 'node:assert/strict';
import { Topic } from '@ethersphere/bee-js';
import { ErrorDetails, ErrorTypes, type ErrorData, PlaylistLevelType } from 'hls.js';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import {
  LiveGapBudget,
  LiveGapBudgetPerStream,
  skipFailedLiveSegment,
  type GapPlayer,
} from '../src/components/SwarmHlsPlayer/liveSegmentGaps';
import {
  ManifestFetcher,
  ManifestStateManager,
  SEGMENTS_AS_WRITTEN,
} from '../src/components/SwarmHlsPlayer/ManifestManagement';
import {
  LIVE_GAP_LIMIT,
  LIVE_GAP_NEWEST_SEGMENTS,
  LIVE_GAP_WINDOW_MS,
} from '../src/components/SwarmHlsPlayer/playerConfig';
import { buildSwarmUri, parseManifest } from '../src/components/SwarmHlsPlayer/playlist';

const OWNER = 'ab'.repeat(20);
const TOPIC_NAME = 'live-gap-test';
const HEX_TOPIC = Topic.fromString(TOPIC_NAME).toString();
const LEVEL_URI = buildSwarmUri(OWNER, TOPIC_NAME);
const GATEWAY = 'https://gateway.example.com';
const GAP = '#EXT-X-GAP';

/** A segment reference, 64 hex digits as the uploader writes one, that says which segment it is. */
const ref = (sequence: number) => sequence.toString(16).padStart(64, '0');
const urlOf = (sequence: number) => `${GATEWAY}/bytes/${ref(sequence)}`;

function livePlaylist(sequences: number[], options: { vod?: boolean; ended?: boolean; gaps?: number[] } = {}): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${sequences[0]}`];
  if (options.vod) {
    lines.push('#EXT-X-PLAYLIST-TYPE:VOD');
  }
  for (const sequence of sequences) {
    if (options.gaps?.includes(sequence)) {
      lines.push(GAP);
    }
    lines.push('#EXTINF:2,', ref(sequence));
  }
  if (options.ended) {
    lines.push('#EXT-X-ENDLIST');
  }
  return lines.join('\n');
}

const manager = ManifestStateManager.getInstance();

function hold(playlist: string): void {
  const parsed = parseManifest(playlist);
  manager.updateManifest(HEX_TOPIC, parsed.headers, parsed.segments, parsed.isFinalized);
}

/** The references the served playlist marks as gaps. */
function servedGaps(): string[] {
  const lines = manager.serialize(HEX_TOPIC, SEGMENTS_AS_WRITTEN).split('\n');
  return lines.flatMap((line, at) => (line === GAP ? [lines[at + 2]] : []));
}

beforeEach(() => {
  manager.clear(HEX_TOPIC);
});

describe('marking a failed live segment as a gap in the served playlist', () => {
  it('marks the newest segment, and the playlist served next says so', () => {
    hold(livePlaylist([10, 11, 12, 13, 14]));

    assert.equal(manager.markLiveGap(HEX_TOPIC, urlOf(14), LIVE_GAP_NEWEST_SEGMENTS), true);

    assert.deepEqual(servedGaps(), [ref(14)]);
  });

  it('keeps the URL hls.js already holds for the segment, which it would otherwise report as a sequence mismatch', () => {
    hold(livePlaylist([10, 11, 12]));
    const viaGateway = (reference: string) => `${GATEWAY}/bytes/${reference}`;
    const before = manager.serialize(HEX_TOPIC, viaGateway);

    manager.markLiveGap(HEX_TOPIC, urlOf(12), LIVE_GAP_NEWEST_SEGMENTS);
    const after = manager.serialize(HEX_TOPIC, viaGateway);

    assert.equal(after, before.replace(`#EXTINF:2,\n${urlOf(12)}`, `${GAP}\n#EXTINF:2,\n${urlOf(12)}`));
  });

  it('marks any of the newest three, and nothing older', () => {
    hold(livePlaylist([10, 11, 12, 13, 14]));

    assert.equal(manager.markLiveGap(HEX_TOPIC, urlOf(11), LIVE_GAP_NEWEST_SEGMENTS), false, 'fourth newest');
    assert.equal(manager.markLiveGap(HEX_TOPIC, urlOf(12), LIVE_GAP_NEWEST_SEGMENTS), true, 'third newest');
    assert.deepEqual(servedGaps(), [ref(12)]);
  });

  it('counts the newest three among segments that are not gaps already', () => {
    hold(livePlaylist([10, 11, 12, 13, 14], { gaps: [13] }));

    assert.equal(manager.markLiveGap(HEX_TOPIC, urlOf(11), LIVE_GAP_NEWEST_SEGMENTS), true);
    assert.equal(manager.markLiveGap(HEX_TOPIC, urlOf(13), LIVE_GAP_NEWEST_SEGMENTS), false, 'already a gap');
    assert.deepEqual(servedGaps(), [ref(11), ref(13)]);
  });

  it('leaves a recording untouched', () => {
    hold(livePlaylist([10, 11, 12], { vod: true }));

    assert.equal(manager.markLiveGap(HEX_TOPIC, urlOf(12), LIVE_GAP_NEWEST_SEGMENTS), false);
    assert.deepEqual(servedGaps(), []);
  });

  it('leaves a finished broadcast untouched', () => {
    hold(livePlaylist([10, 11, 12], { ended: true }));

    assert.equal(manager.markLiveGap(HEX_TOPIC, urlOf(12), LIVE_GAP_NEWEST_SEGMENTS), false);
    assert.deepEqual(servedGaps(), []);
  });

  it('finds the feed from the level URI hls.js knows it by', () => {
    hold(livePlaylist([10, 11, 12]));
    const fetcher = new ManifestFetcher(manager);

    assert.equal(fetcher.markLiveSegmentGap(LEVEL_URI, urlOf(12)), true);
    assert.deepEqual(servedGaps(), [ref(12)]);
  });
});

/** A fragment as hls.js hands it with an error, with only what the decision reads. */
function fragment(sequence: number, gap = false) {
  return { type: PlaylistLevelType.MAIN, sn: sequence, level: 0, url: urlOf(sequence), gap, tagList: [] as string[][] };
}

function fragError(sequence: number, options: { fatal: boolean; hlsGaveUp?: boolean; details?: ErrorDetails }) {
  return {
    type: ErrorTypes.NETWORK_ERROR,
    details: options.details ?? ErrorDetails.FRAG_LOAD_ERROR,
    fatal: options.fatal,
    frag: fragment(sequence, options.hlsGaveUp ?? false),
  } as unknown as ErrorData;
}

function fakePlayer(): GapPlayer & { startLoads: unknown[][] } {
  const startLoads: unknown[][] = [];
  return { levels: [{ uri: LEVEL_URI }], startLoad: (...args: unknown[]) => startLoads.push(args), startLoads };
}

const fetcher = () => new ManifestFetcher(manager);
const markWith = (f: ManifestFetcher) => (levelUri: string, url: string) => f.markLiveSegmentGap(levelUri, url);

describe('what the player does with a segment hls.js gave up on', () => {
  it('turns a fatal failure of the newest segment into a gap and carries on loading, instead of a restart', () => {
    hold(livePlaylist([10, 11, 12, 13, 14]));
    const hls = fakePlayer();
    const data = fragError(14, { fatal: true });

    const skipped = skipFailedLiveSegment(hls, data, markWith(fetcher()), new LiveGapBudget(), 0, 42);

    assert.equal(skipped, true, 'the caller must not restart the player');
    assert.deepEqual(servedGaps(), [ref(14)]);
    assert.equal(data.frag?.gap, true);
    assert.deepEqual(data.frag?.tagList, [['GAP']], 'the fragment hls.js holds skips without a fetch');
    assert.deepEqual(hls.startLoads, [[42, true]], 'loading starts again from the playhead, without a seek');
  });

  it('writes down a segment hls.js skipped by itself, without restarting its loading', () => {
    hold(livePlaylist([10, 11, 12, 13, 14]));
    const hls = fakePlayer();

    const skipped = skipFailedLiveSegment(
      hls,
      fragError(13, { fatal: false, hlsGaveUp: true }),
      markWith(fetcher()),
      new LiveGapBudget(),
      0,
      42,
    );

    assert.equal(skipped, true);
    assert.deepEqual(servedGaps(), [ref(13)]);
    assert.deepEqual(hls.startLoads, []);
  });

  it('leaves a failure hls.js is still retrying alone', () => {
    hold(livePlaylist([10, 11, 12, 13, 14]));
    const budget = new LiveGapBudget();

    const skipped = skipFailedLiveSegment(
      fakePlayer(),
      fragError(14, { fatal: false }),
      markWith(fetcher()),
      budget,
      0,
      42,
    );

    assert.equal(skipped, false);
    assert.deepEqual(servedGaps(), []);
    assert.equal(budget.hasRoom(0), true);
  });

  it('turns a segment that arrived as no media into a gap too', () => {
    hold(livePlaylist([10, 11, 12]));

    const skipped = skipFailedLiveSegment(
      fakePlayer(),
      fragError(12, { fatal: true, details: ErrorDetails.FRAG_PARSING_ERROR }),
      markWith(fetcher()),
      new LiveGapBudget(),
      0,
      42,
    );

    assert.equal(skipped, true);
  });

  it('leaves a segment older than the newest three to the recovery it always had', () => {
    hold(livePlaylist([10, 11, 12, 13, 14]));
    const budget = new LiveGapBudget();

    const skipped = skipFailedLiveSegment(
      fakePlayer(),
      fragError(11, { fatal: true }),
      markWith(fetcher()),
      budget,
      0,
      42,
    );

    assert.equal(skipped, false);
    assert.deepEqual(servedGaps(), []);
    assert.equal(budget.hasRoom(0), true, 'a segment not marked spends nothing');
  });

  it('leaves a recording to the recovery it always had', () => {
    hold(livePlaylist([10, 11, 12], { vod: true }));

    const skipped = skipFailedLiveSegment(
      fakePlayer(),
      fragError(12, { fatal: true }),
      markWith(fetcher()),
      new LiveGapBudget(),
      0,
      42,
    );

    assert.equal(skipped, false);
  });

  it('leaves a playlist failure alone', () => {
    hold(livePlaylist([10, 11, 12]));

    const skipped = skipFailedLiveSegment(
      fakePlayer(),
      fragError(12, { fatal: true, details: ErrorDetails.LEVEL_LOAD_ERROR }),
      markWith(fetcher()),
      new LiveGapBudget(),
      0,
      42,
    );

    assert.equal(skipped, false);
  });
});

describe(`at most ${LIVE_GAP_LIMIT} gaps in any ${LIVE_GAP_WINDOW_MS / 60_000} minutes`, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Publishes one more segment and fails it fatally, as the live edge moves on. */
  function failNext(budget: LiveGapBudget, sequence: number): boolean {
    hold(livePlaylist([sequence]));
    return skipFailedLiveSegment(
      fakePlayer(),
      fragError(sequence, { fatal: true }),
      markWith(fetcher()),
      budget,
      performance.now(),
      42,
    );
  }

  it('lets the fifth inside the window through to the ordinary recovery', () => {
    const budget = new LiveGapBudget();
    const skipped = [100, 101, 102, 103].map((sequence) => {
      vi.advanceTimersByTime(30_000);
      return failNext(budget, sequence);
    });
    vi.advanceTimersByTime(30_000);

    assert.deepEqual(skipped, [true, true, true, true]);
    assert.equal(failNext(budget, 104), false, 'the fifth restarts as it did before');
    assert.equal(servedGaps().includes(ref(104)), false, 'and is not marked');
  });

  it('makes room again once the oldest gap slides out of the window', () => {
    const budget = new LiveGapBudget();
    for (const sequence of [100, 101, 102, 103]) {
      failNext(budget, sequence);
    }

    vi.advanceTimersByTime(LIVE_GAP_WINDOW_MS - 1);
    assert.equal(failNext(budget, 104), false, 'one millisecond short of the window');

    vi.advanceTimersByTime(1);
    assert.equal(failNext(budget, 105), true);
  });

  // The watch page keeps one player while the viewer moves between streams, so the player asks for
  // its budget by stream on every start, a restart included.
  it('gives another stream a full budget, and the same stream after a restart the one it spent', () => {
    const budgets = new LiveGapBudgetPerStream();
    const streamA = buildSwarmUri(OWNER, 'stream-a');
    const streamB = buildSwarmUri(OWNER, 'stream-b');
    for (const sequence of [100, 101, 102, 103]) {
      failNext(budgets.forStream(streamA), sequence);
    }
    assert.equal(failNext(budgets.forStream(streamA), 104), false, 'a restart on stream A keeps its spent budget');

    const onStreamB = [105, 106, 107, 108].map((sequence) => failNext(budgets.forStream(streamB), sequence));
    assert.deepEqual(onStreamB, [true, true, true, true], 'stream B starts with all of its own');
    assert.equal(failNext(budgets.forStream(streamB), 109), false);

    assert.equal(failNext(budgets.forStream(streamA), 110), true, 'coming back to stream A starts it afresh');
  });
});
