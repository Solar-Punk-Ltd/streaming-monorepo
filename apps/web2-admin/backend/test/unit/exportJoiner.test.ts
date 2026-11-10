import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { FfmpegJoiner, runPlaylist } from '../../src/domain/export/Joiner.js';

/**
 * The joiner against the real ffmpeg, on short recordings ffmpeg makes here: H.264 and AAC in one-second MPEG-TS
 * segments, as the stack's packager writes them. Skipped where ffmpeg, or its H.264 encoder, is not installed.
 */
const ffmpegFound =
  spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0 &&
  spawnSync('ffprobe', ['-hide_banner', '-version']).status === 0;

let work: string;
let encoded = false;

/** A session of `seconds` seconds, cut into one-second segments named `<prefix><n>.ts` in `segments/`. */
function session(prefix: string, seconds: number): boolean {
  const out = spawnSync(
    'ffmpeg',
    [
      ...['-hide_banner', '-loglevel', 'error', '-y'],
      ...['-f', 'lavfi', '-i', `testsrc=size=320x240:rate=25:duration=${seconds}`],
      ...['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`],
      ...['-c:v', 'libx264', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0', '-c:a', 'aac'],
      ...['-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod'],
      ...['-hls_segment_filename', path.join(work, 'segments', `${prefix}%d.ts`), path.join(work, `${prefix}.m3u8`)],
    ],
    { encoding: 'utf8' },
  );
  return out.status === 0;
}

function probeDuration(file: string): number {
  const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
    encoding: 'utf8',
  });
  return Number.parseFloat(out.stdout.trim());
}

async function segmentsOf(prefix: string): Promise<string[]> {
  const names = (await readdir(path.join(work, 'segments'))).filter((name) => name.startsWith(prefix));
  return names
    .sort((a, b) => Number(a.slice(prefix.length, -3)) - Number(b.slice(prefix.length, -3)))
    .map((name) => path.join('segments', name));
}

describe('FfmpegJoiner', { skip: ffmpegFound ? false : 'ffmpeg is not installed here' }, () => {
  before(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), 'export-joiner-test-'));
    await mkdir(path.join(work, 'segments'));
    encoded = session('first', 4) && session('second', 3);
  });

  after(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('finds ffmpeg, and says so when it is missing', async () => {
    assert.equal(await new FfmpegJoiner().check(), null);
    assert.match((await new FfmpegJoiner('no-such-ffmpeg').check()) ?? '', /ffmpeg is not installed/);
  });

  it('copies one run into an MP4 of the same length, and reads its height', async (t) => {
    if (!encoded) return t.skip('ffmpeg here has no H.264 encoder to make a recording with');
    const files = await segmentsOf('first');
    const joiner = new FfmpegJoiner();
    await joiner.join([{ files, durations: files.map(() => 1) }], path.join(work, 'one.mp4'), work);

    assert.ok(Math.abs(probeDuration(path.join(work, 'one.mp4')) - 4) < 0.5);
    assert.equal(await joiner.probeHeight(path.join(work, 'one.mp4')), 240);
    // Nothing of the work is left behind but the MP4.
    assert.deepEqual(
      (await readdir(work)).filter((name) => name.startsWith('run')),
      [],
    );
  });

  it('joins two sessions, whose clocks both start at zero, one after the other', async (t) => {
    if (!encoded) return t.skip('ffmpeg here has no H.264 encoder to make a recording with');
    const first = await segmentsOf('first');
    const second = await segmentsOf('second');
    await new FfmpegJoiner().join(
      [
        { files: first, durations: first.map(() => 1) },
        { files: second, durations: second.map(() => 1) },
      ],
      path.join(work, 'two.mp4'),
      work,
    );

    assert.ok(Math.abs(probeDuration(path.join(work, 'two.mp4')) - 7) < 0.6);
  });

  it('does not run ffmpeg for an export already stopped', async (t) => {
    if (!encoded) return t.skip('ffmpeg here has no H.264 encoder to make a recording with');
    const files = await segmentsOf('first');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      new FfmpegJoiner().join(
        [{ files, durations: files.map(() => 1) }],
        path.join(work, 'stopped.mp4'),
        work,
        controller.signal,
      ),
      /stopped/,
    );
  });
});

describe('the playlist of a run', () => {
  it('names the local segment files with their lengths, as a finished VOD playlist', () => {
    assert.equal(
      runPlaylist({ files: ['segments/a.ts', 'segments/b.ts'], durations: [2, 1.5] }),
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:2',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXTINF:2.000000,',
        'segments/a.ts',
        '#EXTINF:1.500000,',
        'segments/b.ts',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
    );
  });
});
