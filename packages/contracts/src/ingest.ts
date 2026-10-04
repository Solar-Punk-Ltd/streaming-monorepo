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

/** What a console calls the thing whose ingest it shows: a stage in the web2 admin, a deployment in the manager. */
export type IngestOwner = 'stage' | 'deployment';

/**
 * What a console says beside RTMP details, so every console tells a broadcaster the same thing. It states what RTMP
 * does with a stream key and nothing about which ports are reachable, which is the operator's firewall. RTMP has no
 * passphrase, so the stream key crosses the network as readable text. SRT sends its stream id, key included, before
 * its encryption starts, so a key read off either protocol publishes over RTMP. The takeover setting decides whether
 * such a publisher can also replace a live broadcast. `hasSrtPassphrase` says whether this owner's SRT ingest has a
 * passphrase at all, so the text never offers one that is not there.
 */
export function rtmpUnencryptedWarning(owner: IngestOwner, hasSrtPassphrase: boolean): string {
  const exposure =
    'RTMP is not encrypted, so your stream key crosses the network as readable text. A key read off the network ' +
    'publishes to this stream over RTMP, whichever protocol it was read from, because SRT sends the key before its ' +
    'encryption starts. With the takeover on, a publisher with the key can also replace your live broadcast with theirs.';
  const srt = hasSrtPassphrase
    ? `This ${owner}'s SRT passphrase keeps your picture private but not your key.`
    : `This ${owner} has no SRT passphrase, so the picture is not private either.`;
  return `${exposure} ${srt}`;
}

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
