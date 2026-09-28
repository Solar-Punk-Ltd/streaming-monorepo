import type { MediaType } from './mediaType.js';

/**
 * Where a broadcaster sends a stream. The ingest stream id is `<app>/<stream>`: the application is the media type,
 * since the stack maps `audio` to audio and anything else to video, and the stream is the name the uploader finds
 * the stream by. A per-stream key, when the ingest checks one, rides in the `key` parameter.
 */

/** The query parameter a broadcaster presents its publish key in. */
export const PUBLISH_KEY_PARAM = 'key';

/** An ingest server, as far as the addresses on it need one. */
export interface IngestAddress {
  host: string;
  srtPort: number;
  rtmpPort: number;
}

export function buildIngestStreamId(app: MediaType, stream: string): string {
  return `${app}/${stream}`;
}

/** The SRT line SRS reads: the stream id, then the key when there is one, inside `streamid=`. */
export function buildSrtPublishUrl(
  address: Pick<IngestAddress, 'host' | 'srtPort'>,
  streamId: string,
  publishKey?: string,
): string {
  const key = publishKey === undefined ? '' : `?${PUBLISH_KEY_PARAM}=${publishKey}`;
  return `srt://${address.host}:${address.srtPort}?streamid=#!::r=${streamId}${key},m=publish`;
}

export function buildRtmpServer(address: Pick<IngestAddress, 'host' | 'rtmpPort'>, app: MediaType): string {
  return `rtmp://${address.host}:${address.rtmpPort}/${app}`;
}

export function buildRtmpStreamKey(stream: string, publishKey: string): string {
  return `${stream}?${PUBLISH_KEY_PARAM}=${publishKey}`;
}

/**
 * Where OBS takes the SRT passphrase from: a `passphrase=` on its Server line, the Password under "Use
 * authentication" (which OBS 29.1 and later hands to SRT as the passphrase), or nowhere, because the ingest has none.
 */
export type SrtPassphraseRoute = 'server' | 'authentication' | 'none';

export interface ObsSrtServer {
  /** What goes in OBS's "Server" box. Its "Stream Key" box stays empty. */
  server: string;
  passphraseRoute: SrtPassphraseRoute;
}

/**
 * RFC 3986's unreserved characters. OBS reads its Server line with FFmpeg's `av_find_info_tag`, which ends a value
 * at `&` and turns `+` into a space, and it never percent-decodes, so only these are certain to reach SRT as typed.
 */
const SERVER_LINE_SAFE_PASSPHRASE = /^[A-Za-z0-9._~-]+$/;

/**
 * What a console says beside a passphrase that `buildObsSrtServer` routes to OBS's "Use authentication" Password,
 * so every console tells a broadcaster the same thing.
 */
export const OBS_SRT_PASSPHRASE_FIELD_HELP =
  'This passphrase has characters the Server line cannot carry. In OBS, tick Use authentication, leave Username empty and paste this into Password.';

/**
 * OBS's Custom service set up for SRT, as OBS 31 reads it: the "Stream Key" box becomes the SRT stream id and a
 * `streamid=` on the Server line replaces it, so that box stays empty. A `passphrase=` on the Server line is read
 * after the "Use authentication" Password and wins, so the passphrase rides there whenever it can.
 */
export function buildObsSrtServer(srtUrl: string, passphrase: string | null): ObsSrtServer {
  if (!passphrase) return { server: srtUrl, passphraseRoute: 'none' };
  if (!SERVER_LINE_SAFE_PASSPHRASE.test(passphrase)) {
    return { server: srtUrl, passphraseRoute: 'authentication' };
  }
  const separator = srtUrl.includes('?') ? '&' : '?';
  return { server: `${srtUrl}${separator}passphrase=${passphrase}`, passphraseRoute: 'server' };
}
