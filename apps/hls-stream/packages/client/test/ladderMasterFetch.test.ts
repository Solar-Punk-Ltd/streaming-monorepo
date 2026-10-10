import { Topic } from '@ethersphere/bee-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ManifestFetcher, ManifestStateManager } from '../src/components/SwarmHlsPlayer/ManifestManagement';
import { RequestJitter } from '../src/utils/requestJitter';

import { slotPathsOf } from './helpers/slotPaths';
import { swarmOverGlobalFetch } from './helpers/playerReader';

/**
 * The first browser ever pointed at a published ladder failed with three
 * `networkError manifestLoadError` and zero rung requests (sitting 2026-08-28, arm
 * `20260828-062459`). The uploader's half was proven correct on the host: the group feed served
 * exactly the master below, inline, 200. So the defect is between receiving this text and starting
 * the rung walks, and this test replays that exact input through `fetchSource`.
 */

/** Verbatim from the live group feed, 2026-08-28, minus only the trailing newline. */
const OWNER = '00000000000000000000000000000000000fa4e1';
const GROUP_ID = '76c7bb63-39dc-4159-ba85-a085e4431a54';
const RUNG_IDS = [
  '4ebfe43a-82f6-4d61-97e5-5d77513a15a4',
  'ec46506e-dca4-4840-ae7c-cc3ad7dbac44',
  'f7bb0580-cfee-4cfe-8372-17c3cfe80751',
  '6eb261b5-6c3a-4eb6-bed6-89660b88d44a',
];
const PUBLISHED_MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-STREAM-INF:BANDWIDTH=1012693,AVERAGE-BANDWIDTH=913576,RESOLUTION=640x360',
  `swarm://${OWNER}/${RUNG_IDS[0]}`,
  '#EXT-X-STREAM-INF:BANDWIDTH=1557141,AVERAGE-BANDWIDTH=1425440,RESOLUTION=854x480',
  `swarm://${OWNER}/${RUNG_IDS[1]}`,
  '#EXT-X-STREAM-INF:BANDWIDTH=3435136,AVERAGE-BANDWIDTH=3061416,RESOLUTION=1280x720',
  `swarm://${OWNER}/${RUNG_IDS[2]}`,
  '#EXT-X-STREAM-INF:BANDWIDTH=5634987,AVERAGE-BANDWIDTH=5146341,RESOLUTION=1920x1080',
  `swarm://${OWNER}/${RUNG_IDS[3]}`,
  '',
].join('\n');

const RUNG_MEDIA = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', '#EXTINF:0.5,', 'seg-0.ts', ''].join(
  '\n',
);

/** No stagger, so the walk is driven rather than waited out, same as ManifestFetcher.test.ts. */
const NO_JITTER = new RequestJitter(0, () => 0);

const manager = ManifestStateManager.getInstance();
const realFetch = globalThis.fetch;

const groupTopicHex = Topic.fromString(GROUP_ID).toString();
const rungTopicHex = new Map(RUNG_IDS.map((id) => [Topic.fromString(id).toString(), id]));
const rungSlots = slotPathsOf(
  OWNER,
  RUNG_IDS.map((id) => Topic.fromString(id)),
);

/** The rung a read was for, by hex topic, or null for any other read. */
function rungOf(url: string): string | null {
  return rungSlots.get(new URL(url).pathname.slice(1))?.hex ?? null;
}

function feedResponse(body: string, index = 10): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Swarm-Feed-Index': index.toString(16).padStart(16, '0'),
      'Swarm-Feed-Index-Next': (index + 1).toString(16).padStart(16, '0'),
    },
  });
}

describe('a published ladder master starts the rungs (the 2026-08-28 sitting failure)', () => {
  let fetched: string[];
  let fetcher: ManifestFetcher;

  beforeEach(() => {
    manager.clear(groupTopicHex);
    for (const hex of rungTopicHex.keys()) {
      manager.clear(hex);
    }
    fetched = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      if (url.includes(groupTopicHex)) {
        return feedResponse(PUBLISHED_MASTER);
      }
      // Each rung holds its first slot only, so the search for its newest index ends there.
      const slot = rungSlots.get(new URL(url).pathname.slice(1));
      if (slot?.index === 0) {
        return new Response(RUNG_MEDIA, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    fetcher = new ManifestFetcher(manager, undefined, undefined, NO_JITTER);
    fetcher.useSwarm(swarmOverGlobalFetch('http://gateway.test'));
  });

  afterEach(async () => {
    fetcher.unregisterLadder(`swarm://${OWNER}/${GROUP_ID}`);
    await fetcher.settled();
    globalThis.fetch = realFetch;
  });

  it('returns the master text, rather than throwing, and reads no rung until a level is asked for', async () => {
    const text = await fetcher.fetchSource(`swarm://${OWNER}/${GROUP_ID}`);

    expect(text).toBe(PUBLISHED_MASTER);
    await fetcher.settled();
    const rungsAsked = [...rungTopicHex.keys()].filter((hex) => fetched.some((url) => rungOf(url) === hex));
    expect(rungsAsked.length, `rung feeds asked for: ${rungsAsked.length} of 4`).toBe(0);
  });

  /**
   * The level request hls.js makes right after parsing the master, for the rung it picked. The
   * failed arm's gateway log shows the master served and then silence, which is also what a level
   * fetch that never resolves looks like from outside.
   */
  it('serves a rung playlist to the level request that follows the master', async () => {
    await fetcher.fetchSource(`swarm://${OWNER}/${GROUP_ID}`);

    const level = fetcher.fetch(`swarm://${OWNER}/${RUNG_IDS[2]}`);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('the level fetch never resolved, which a viewer reads as a dead manifest')),
        4000,
      ),
    );
    const playlist = await Promise.race([level, timeout]);

    expect(playlist).toContain('#EXTINF');
    expect(playlist).toContain('seg-0.ts');
    const rungsAsked = [...rungTopicHex.keys()].filter((hex) => fetched.some((url) => rungOf(url) === hex));
    expect(rungsAsked, 'a level request read a rung other than its own').toEqual([
      Topic.fromString(RUNG_IDS[2]).toString(),
    ]);
  });
});
