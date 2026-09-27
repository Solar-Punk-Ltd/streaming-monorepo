import type { MediaType } from './api.js';

/**
 * OBS / encoder connection details for one stream.
 *
 * The ingest stream id is `<app>/<stream>`: `app` is the media type because
 * swarm-hls-stream maps app 'audio' to audio and anything else to video, and
 * `stream` is the stream's topic UUID so the uploader can find the draft by
 * name later. The per-stream key rides in the `key=` query parameter, the
 * shape swarm-hls-stream's publisher-auth branch verifies. The SRT passphrase
 * is one value for the whole SRS server and comes as its own field, which
 * `buildObsSrtServer` puts on the Server line wherever OBS can read it there.
 */
export interface IngestDetails {
  streamId: string;
  app: MediaType;
  stream: string;
  /** 32 hex chars, rotatable. */
  publishKey: string;
  publishKeyRotatedAt: string | null;
  srt: {
    /**
     * The SRT publish URL without the passphrase. What OBS's "Server" box
     * takes is `buildObsSrtServer(url, passphrase).server`.
     */
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

export function buildRtmpServer(endpoint: Pick<IngestEndpoint, 'host' | 'rtmpPort'>, app: MediaType): string {
  return `rtmp://${endpoint.host}:${endpoint.rtmpPort}/${app}`;
}

export function buildRtmpStreamKey(stream: string, publishKey: string): string {
  return `${stream}?key=${publishKey}`;
}

/**
 * Where OBS takes the SRT passphrase from: a `passphrase=` on its Server line,
 * the Password under "Use authentication" (which OBS 29.1 and later hands to
 * SRT as the passphrase), or nowhere, because the ingest has none.
 */
export type SrtPassphraseRoute = 'server' | 'authentication' | 'none';

export interface ObsSrtServer {
  /** What goes in OBS's "Server" box. Its "Stream Key" box stays empty. */
  server: string;
  passphraseRoute: SrtPassphraseRoute;
}

/**
 * RFC 3986's unreserved characters. OBS reads its Server line with FFmpeg's
 * `av_find_info_tag`, which ends a value at `&` and turns `+` into a space,
 * and it never percent-decodes, so only these are certain to reach SRT as
 * typed.
 */
const SERVER_LINE_SAFE_PASSPHRASE = /^[A-Za-z0-9._~-]+$/;

/**
 * OBS's Custom service set up for SRT, as OBS 31 reads it: the "Stream Key"
 * box becomes the SRT stream id and a `streamid=` on the Server line replaces
 * it, so that box stays empty. A `passphrase=` on the Server line is read after
 * the "Use authentication" Password and wins, so the passphrase rides there
 * whenever it can.
 */
export function buildObsSrtServer(srtUrl: string, passphrase: string | null): ObsSrtServer {
  if (!passphrase) return { server: srtUrl, passphraseRoute: 'none' };
  if (!SERVER_LINE_SAFE_PASSPHRASE.test(passphrase)) {
    return { server: srtUrl, passphraseRoute: 'authentication' };
  }
  const separator = srtUrl.includes('?') ? '&' : '?';
  return {
    server: `${srtUrl}${separator}passphrase=${passphrase}`,
    passphraseRoute: 'server',
  };
}
