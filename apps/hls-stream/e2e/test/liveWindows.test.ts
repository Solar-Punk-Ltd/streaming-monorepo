import { encodeLiveWindowPayload, LIVE_PLAYLIST_WINDOW_MS, windowAddress, windowOf } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Host } from '../src/harness/host.js';
import { LIVE_WINDOW_LOOKBACK_MS, liveWindowsToRead, readNewestLiveWindow } from '../src/harness/liveWindows.js';

const OWNER = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const TOPIC = 'live-topic';
const NOW_MS = 1_800_000_001_500;
const PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n';

/** A gateway holding the given windows of {@link TOPIC}, answering 404 for every other chunk. */
function gatewayWith(windows: ReadonlyMap<number, string>, asked: string[] = []): Host {
  const byPath = new Map(
    [...windows].map(([window, payload]) => [
      `/chunks/${windowAddress({ topic: TOPIC, kind: 'live', windowMs: LIVE_PLAYLIST_WINDOW_MS, window }, OWNER).toHex()}`,
      payload,
    ]),
  );
  return {
    localChunkPayload: async (_port: number, path: string) => {
      asked.push(path);
      const payload = byPath.get(path);
      return payload === undefined ? { status: 404, payload: null } : { status: 200, payload };
    },
  } as unknown as Host;
}

function payloadOf(writtenAt: number): string {
  return new TextDecoder().decode(encodeLiveWindowPayload(PLAYLIST, writtenAt));
}

describe('which live windows a reader asks for', () => {
  it('starts at the newest window that ended a read margin ago and walks back the lookback', () => {
    const windows = liveWindowsToRead(NOW_MS);
    const newest = windowOf(NOW_MS - 1_000, LIVE_PLAYLIST_WINDOW_MS) - 1;

    assert.equal(windows[0], newest, 'the window still being written is never asked for');
    assert.equal(windows.length, LIVE_WINDOW_LOOKBACK_MS / LIVE_PLAYLIST_WINDOW_MS);
    assert.deepEqual(
      windows,
      windows.map((_, i) => newest - i),
      'newest first, one window at a time',
    );
  });
});

describe('reading the newest live window of a topic', () => {
  it('hands back the playlist of the newest window written, without its written-at line', async () => {
    const [newest, older] = liveWindowsToRead(NOW_MS).slice(2);
    const asked: string[] = [];
    const host = gatewayWith(
      new Map([
        [newest, payloadOf(NOW_MS - 5_000)],
        [older, payloadOf(NOW_MS - 7_000)],
      ]),
      asked,
    );

    const read = await readNewestLiveWindow(host, 10_074, OWNER, TOPIC, NOW_MS);

    assert.deepEqual(read, { window: newest, playlist: PLAYLIST, writtenAt: NOW_MS - 5_000 });
    assert.equal(asked.length, 3, 'nothing older is read once a window was found');
  });

  it('says why when no window of the lookback was written', async () => {
    const read = await readNewestLiveWindow(gatewayWith(new Map()), 10_074, OWNER, TOPIC, NOW_MS);

    assert.match('reason' in read ? read.reason : '', /no live window of live-topic in the last 30 s/);
  });

  it('says why when the newest window holds something that is not a live window', async () => {
    const [newest] = liveWindowsToRead(NOW_MS);
    const read = await readNewestLiveWindow(
      gatewayWith(new Map([[newest, 'not a playlist']])),
      10_074,
      OWNER,
      TOPIC,
      NOW_MS,
    );

    assert.match('reason' in read ? read.reason : '', new RegExp(`window ${newest} .*not a live window`));
  });
});
