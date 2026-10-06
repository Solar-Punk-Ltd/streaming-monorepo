import { MEDIA_TYPE_VIDEO, StreamState } from '../../src/types.js';

/**
 * A stream state as RecoveryStore.load would return it, for exercising the recovery path.
 *
 * In a module of its own, apart from `fakes.ts`, because a fixture run as a process of its own imports
 * it, and `fakes.ts` registers a hook on the test runner that such a process must not carry.
 */
export function makeRecoveredState(streamId: string): StreamState {
  return {
    streamId,
    streamRawTopic: 'topic-xyz',
    mediatype: MEDIA_TYPE_VIDEO,
    segments: [{ index: 0, duration: 2, ref: 'ref0', discontinuity: false }],
    hlsHeaders: ['#EXTM3U', '#EXT-X-VERSION:3'],
    isFirstSegmentReady: true,
    isFirstManifestReady: true,
    pendingDiscontinuity: false,
    liveManifestStale: false,
    updatedAt: Date.now(),
  };
}
