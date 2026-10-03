import type { E2EConfig } from '../config.js';
import { INGEST_RTMP, INGEST_SRT, type IngestProtocol } from '../ingestProtocol.js';

import { ingestUrl, type PresentedKey } from './engine.js';
import { type FfmpegProcess, startFfmpeg } from './ffmpegProcess.js';

const DEFAULT_FPS = 30;

/**
 * Seconds between the keyframes this publisher emits.
 *
 * Named because it is read outside the ffmpeg line: against a single-rendition stage SRS has no
 * cadence of its own, so this is the number that decides the segment length and
 * `suites/preflight/segment-length.test.ts` has to know it. With the ABR ladder on the stage
 * transcodes and this is not in the path at all.
 */
export const PUBLISHER_GOP_SECONDS = 2;

/**
 * The container each protocol carries, as ffmpeg names its muxer: SRS takes MPEG-TS inside SRT and FLV inside RTMP.
 * FLV's muxer seeks back to write the duration and size when it closes, which a live connection cannot do, so it is
 * told not to try.
 */
const OUTPUT_FORMAT: Record<IngestProtocol, readonly string[]> = {
  [INGEST_SRT]: ['-f', 'mpegts'],
  [INGEST_RTMP]: ['-f', 'flv', '-flvflags', 'no_duration_filesize'],
};

export interface Publisher extends FfmpegProcess {
  readonly url: string;
  readonly protocol: IngestProtocol;
}

export interface PublisherOptions {
  fps?: number;
  streamPath?: string;
  /** The protocol to publish over. The run's `E2E_INGEST_PROTOCOL` when the suite names none. */
  protocol?: IngestProtocol;
  /** The key to present instead of the stream's own, or null for none. See `PresentedKey`. */
  publishKey?: PresentedKey;
}

/**
 * The ffmpeg arguments for one publish: a video and audio test pattern encoded the same way over either protocol, so
 * the protocol is the only thing a suite run over RTMP changes, then the container that protocol carries.
 */
export function publisherArgs(url: string, protocol: IngestProtocol, fps: number): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-re',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1280x720:rate=${fps}`,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'zerolatency',
    '-g',
    String(fps * PUBLISHER_GOP_SECONDS),
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-b:a',
    '128k',
    ...OUTPUT_FORMAT[protocol],
    url,
  ];
}

/** Start an ffmpeg test-pattern (video+audio) publish to the configured engine's ingest. */
export function startPublisher(cfg: E2EConfig, opts: PublisherOptions = {}): Publisher {
  const protocol = opts.protocol ?? cfg.ingestProtocol;
  const url = ingestUrl(cfg, protocol, opts.streamPath ?? cfg.streamPath, opts.publishKey);

  return { url, protocol, ...startFfmpeg(publisherArgs(url, protocol, opts.fps ?? DEFAULT_FPS)) };
}
