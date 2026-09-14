import type { MediaType } from './api.js';

/**
 * OBS / encoder connection details for one stream.
 *
 * The ingest stream id is `<app>/<stream>`: `app` is the media type because
 * swarm-hls-stream maps app 'audio' to audio and anything else to video, and
 * `stream` is the stream's topic UUID so the uploader can find the draft by
 * name later. The per-stream key rides in the `key=` query parameter, the
 * shape swarm-hls-stream's publisher-auth branch verifies. The SRT passphrase
 * is one value for the whole SRS server and is shown separately.
 */
export interface IngestDetails {
  streamId: string;
  app: MediaType;
  stream: string;
  /** 32 hex chars, rotatable. */
  publishKey: string;
  publishKeyRotatedAt: string | null;
  srt: {
    /** Full URL for OBS "Server" with SRT; put `passphrase` in the OBS field. */
    url: string;
    passphrase: string | null;
  };
  rtmp: {
    /** OBS "Server". */
    server: string;
    /** OBS "Stream Key". */
    streamKey: string;
  };
  /**
   * Whether the ingest currently verifies `key=`. False until the deployed
   * uploader carries publisher auth; the UI shows a note when false.
   */
  keyVerified: boolean;
}

export interface IngestEndpoint {
  host: string;
  srtPort: number;
  rtmpPort: number;
  srtPassphrase: string | null;
  keyVerified: boolean;
}

export function buildIngestStreamId(app: MediaType, stream: string): string {
  return `${app}/${stream}`;
}

export function buildSrtPublishUrl(
  endpoint: Pick<IngestEndpoint, 'host' | 'srtPort'>,
  streamId: string,
  publishKey: string,
): string {
  return `srt://${endpoint.host}:${endpoint.srtPort}?streamid=#!::r=${streamId}?key=${publishKey},m=publish`;
}

export function buildRtmpServer(
  endpoint: Pick<IngestEndpoint, 'host' | 'rtmpPort'>,
  app: MediaType,
): string {
  return `rtmp://${endpoint.host}:${endpoint.rtmpPort}/${app}`;
}

export function buildRtmpStreamKey(stream: string, publishKey: string): string {
  return `${stream}?key=${publishKey}`;
}
