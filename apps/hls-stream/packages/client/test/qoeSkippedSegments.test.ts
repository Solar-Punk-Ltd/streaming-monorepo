/**
 * A live segment the player plays past as a gap is a moment of lost picture, not a failure of the
 * session. The overlay used to count the fatal error hls.js raised for it as one, with a reconnect
 * attempt beside it, so a viewer whose picture only skipped read as a viewer whose picture stopped.
 */

import assert from 'node:assert/strict';
import { Topic } from '@ethersphere/bee-js';
import type Hls from 'hls.js';
import { ErrorDetails, ErrorTypes, type ErrorData, Events, PlaylistLevelType } from 'hls.js';
import { beforeEach, describe, it } from 'vitest';

import { LiveGapBudget, skipFailedLiveSegment } from '../src/components/SwarmHlsPlayer/liveSegmentGaps';
import { ManifestFetcher, ManifestStateManager } from '../src/components/SwarmHlsPlayer/ManifestManagement';
import { attachQoeTracking, type QoeMetrics } from '../src/components/SwarmHlsPlayer/overlays/qoe/useHlsQoeMetrics';
import { buildSwarmUri, parseManifest } from '../src/components/SwarmHlsPlayer/playlist';

const OWNER = 'cd'.repeat(20);
const TOPIC_NAME = 'qoe-gap-test';
const HEX_TOPIC = Topic.fromString(TOPIC_NAME).toString();
const LEVEL_URI = buildSwarmUri(OWNER, TOPIC_NAME);
const GATEWAY = 'https://gateway.example.com';

const ref = (sequence: number) => sequence.toString(16).padStart(64, '0');
const urlOf = (sequence: number) => `${GATEWAY}/bytes/${ref(sequence)}`;

const manager = ManifestStateManager.getInstance();

function holdLivePlaylist(sequences: number[]): void {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${sequences[0]}`];
  for (const sequence of sequences) {
    lines.push('#EXTINF:2,', ref(sequence));
  }
  const parsed = parseManifest(lines.join('\n'));
  manager.updateManifest(HEX_TOPIC, parsed.headers, parsed.segments, parsed.isFinalized);
}

function fragError(sequence: number, options: { fatal: boolean; details?: ErrorDetails; hlsGaveUp?: boolean }) {
  return {
    type: ErrorTypes.NETWORK_ERROR,
    details: options.details ?? ErrorDetails.FRAG_LOAD_ERROR,
    fatal: options.fatal,
    frag: {
      type: PlaylistLevelType.MAIN,
      sn: sequence,
      level: 0,
      url: urlOf(sequence),
      gap: options.hlsGaveUp ?? false,
      tagList: [] as string[][],
    },
  } as unknown as ErrorData;
}

type ListenerOrder = 'player first' | 'overlay first';

/**
 * hls.js calls its error listeners in the order they subscribed, and nothing in the player fixes
 * which of the two subscribes first, so each case runs in both orders.
 */
function makeWatchedPlayer(order: ListenerOrder) {
  const errorListeners: ((event: string, data: ErrorData) => void)[] = [];
  const hls = {
    levels: [{ uri: LEVEL_URI }],
    startLoad: () => {},
    on: (event: string, listener: (event: string, data: ErrorData) => void) => {
      if (event === Events.ERROR) {
        errorListeners.push(listener);
      }
    },
    off: () => {},
  };
  const video = { addEventListener: () => {}, removeEventListener: () => {} };
  const fetcher = new ManifestFetcher(manager);
  const budget = new LiveGapBudget();
  const playerRecovered: ErrorData[] = [];

  const playerListener = (_event: string, data: ErrorData) => {
    const skipped = skipFailedLiveSegment(
      hls,
      data,
      (levelUri, url) => fetcher.markLiveSegmentGap(levelUri, url),
      budget,
      0,
      42,
    );
    if (!skipped && data.fatal) {
      playerRecovered.push(data);
    }
  };

  if (order === 'player first') {
    hls.on(Events.ERROR, playerListener);
  }
  let latest: QoeMetrics | null = null;
  const detach = attachQoeTracking(video as unknown as HTMLMediaElement, hls as unknown as Hls, (metrics) => {
    latest = metrics;
  });
  if (order === 'overlay first') {
    hls.on(Events.ERROR, playerListener);
  }

  return {
    detach,
    playerRecovered,
    raise: async (data: ErrorData) => {
      for (const listener of errorListeners) {
        listener(Events.ERROR, data);
      }
      await Promise.resolve();
    },
    metrics: (): QoeMetrics => {
      assert.ok(latest, 'the tracker never reported any metrics');
      return latest;
    },
  };
}

beforeEach(() => {
  manager.clear(HEX_TOPIC);
});

for (const order of ['player first', 'overlay first'] as const) {
  describe(`a segment played past as a gap, ${order}`, () => {
    it('is a skipped segment, not a fatal error, a reconnect attempt or a failed start', async () => {
      holdLivePlaylist([10, 11, 12, 13, 14]);
      const player = makeWatchedPlayer(order);

      await player.raise(fragError(14, { fatal: true }));

      const metrics = player.metrics();
      assert.equal(metrics.segmentsSkipped, 1);
      assert.equal(metrics.fatalErrorCount, 0);
      assert.equal(metrics.reconnectAttempts, 0);
      assert.equal(metrics.startupFailed, false);
      player.detach();
    });

    it('counts a segment hls.js skipped by itself and the player wrote down', async () => {
      holdLivePlaylist([10, 11, 12, 13, 14]);
      const player = makeWatchedPlayer(order);

      await player.raise(fragError(13, { fatal: false, hlsGaveUp: true }));

      assert.equal(player.metrics().segmentsSkipped, 1);
      assert.equal(player.metrics().fatalErrorCount, 0);
      player.detach();
    });

    // hls.js reports the gap it then steps over as an error of its own, which is the same skip.
    it('does not count the fragGap that follows as a second skip', async () => {
      holdLivePlaylist([10, 11, 12, 13, 14]);
      const player = makeWatchedPlayer(order);

      await player.raise(fragError(14, { fatal: true }));
      await player.raise(fragError(14, { fatal: false, details: ErrorDetails.FRAG_GAP, hlsGaveUp: true }));

      assert.equal(player.metrics().segmentsSkipped, 1);
      player.detach();
    });

    it('still counts a fatal error the player recovers from the ordinary way', async () => {
      holdLivePlaylist([10, 11, 12, 13, 14]);
      const player = makeWatchedPlayer(order);

      await player.raise(fragError(11, { fatal: true }));

      assert.equal(player.playerRecovered.length, 1, 'a segment older than the newest three is not a gap');
      assert.equal(player.metrics().segmentsSkipped, 0);
      assert.equal(player.metrics().fatalErrorCount, 1);
      assert.equal(player.metrics().reconnectAttempts, 1);
      player.detach();
    });
  });
}
