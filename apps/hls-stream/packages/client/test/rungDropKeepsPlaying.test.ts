// @vitest-environment jsdom
import { Topic } from '@ethersphere/bee-js';
import { buildMasterPlaylist, buildSwarmUri } from '@swarm-hls-stream/shared';
import Hls, { type ErrorData, Events } from 'hls.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';

import { CustomManifestLoader, manifestFetcher } from '../src/components/SwarmHlsPlayer/CustomManifestLoader';
import { RungRefusedError } from '../src/components/SwarmHlsPlayer/ManifestManagement';
import { buildPlayerConfig } from '../src/components/SwarmHlsPlayer/playerConfig';
import { attachRungFailover } from '../src/components/SwarmHlsPlayer/rungHealth';

/**
 * A rung the poller refuses at a switch, run through the real hls.js with the player's own playlist
 * loader. Seen live on 2026-10-15: the poller refused 1080p, the player took its level out, and the
 * refused level request then reached hls.js as a load error naming the level's old number. That number
 * had gone with the removal, so hls.js found no level to switch to, called the error fatal, and the
 * player restarted the recording from 0.
 */

const OWNER = 'aabbccddeeff00112233445566778899aabbccdd';
const RUNGS = [
  { name: 'drop-360p', height: 360, bandwidth: 700_000 },
  { name: 'drop-720p', height: 720, bandwidth: 2_800_000 },
  { name: 'drop-1080p', height: 1080, bandwidth: 5_000_000 },
] as const;
const TOP = RUNGS[RUNGS.length - 1];
const hexOf = (name: string): string => Topic.fromString(name).toString();
const SOURCE = buildSwarmUri(OWNER, 'drop-group');

function mediaPlaylist(name: string, finished: boolean): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0'];
  if (finished) {
    lines.push('#EXT-X-PLAYLIST-TYPE:VOD');
  }
  for (let i = 0; i < 10; i++) {
    lines.push('#EXTINF:2.0,', `https://gateway.example.com/${name}/${i}.ts`);
  }
  if (finished) {
    lines.push('#EXT-X-ENDLIST');
  }
  return lines.join('\n') + '\n';
}

let hls: Hls | null = null;

afterEach(() => {
  hls?.destroy();
  hls = null;
  vi.restoreAllMocks();
});

/**
 * Plays the ladder from its top rung while the poller refuses that rung, the way `ManifestFetcher.fetch`
 * does: it announces the rung stopped, which takes the level out, and then ends the request.
 */
async function playWhileTopIsRefused(finished: boolean): Promise<{ errors: ErrorData[]; levels: number[] }> {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const renditions = RUNGS.map((rung) => ({
    topic: rung.name,
    bandwidth: rung.bandwidth,
    avgBandwidth: rung.bandwidth,
    width: (rung.height * 16) / 9,
    height: rung.height,
  }));
  vi.spyOn(manifestFetcher, 'fetchSource').mockResolvedValue(buildMasterPlaylist(OWNER, renditions as never));
  vi.spyOn(manifestFetcher, 'fetch').mockImplementation(async (url: string) => {
    const rung = RUNGS.find((candidate) => url.endsWith(`/${candidate.name}`));
    assert.ok(rung, `a level request for ${url}, which is no rung of this ladder`);
    if (rung === TOP) {
      manifestFetcher.feedHealth.recordRungStopped(hexOf(TOP.name), {
        reason: "its newest segment is 496s behind the playing quality's",
        failoverTo: hexOf(RUNGS[0].name),
      });
      throw new RungRefusedError(hexOf(TOP.name));
    }
    return mediaPlaylist(rung.name, finished);
  });

  const player = new Hls(buildPlayerConfig({ pLoader: CustomManifestLoader as never }));
  hls = player;
  const errors: ErrorData[] = [];
  const levels: number[] = [];
  player.on(Events.ERROR, (_event, data) => errors.push(data));
  player.on(Events.LEVEL_LOADED, (_event, data) => levels.push(player.levels[data.level]?.height ?? -1));
  const detach = attachRungFailover(player, manifestFetcher.feedHealth);

  await new Promise<void>((resolve) => {
    player.on(Events.MANIFEST_PARSED, () => {
      player.startLevel = RUNGS.length - 1;
      player.startLoad();
      resolve();
    });
    player.loadSource(SOURCE);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  detach();
  return { errors, levels };
}

describe('a rung refused at a switch is taken out without stopping the player', () => {
  it('raises no fatal error on a finished recording, and carries on with a rung that is left', async () => {
    const { errors, levels } = await playWhileTopIsRefused(true);

    assert.deepEqual(
      errors.filter((error) => error.fatal).map((error) => error.details),
      [],
      'a fatal error is what restarts the player from the start',
    );
    assert.equal(hls?.levels.length, RUNGS.length - 1, 'the refused rung was not taken out');
    assert.ok(levels.length > 0 && !levels.includes(TOP.height), `levels loaded: ${levels.join(', ')}`);
  });

  it('raises no fatal error on a live broadcast either', async () => {
    const { errors } = await playWhileTopIsRefused(false);

    assert.deepEqual(
      errors.filter((error) => error.fatal).map((error) => error.details),
      [],
    );
  });
});
