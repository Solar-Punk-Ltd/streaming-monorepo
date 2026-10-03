/**
 * Per-engine behavior — the suite runs against exactly one media engine, selected by E2E_ENGINE.
 * SRS (default) and OME differ in three externally-observable ways the tests must adapt to:
 *
 *  - the ingest URL the publisher dials, over SRT on both and over RTMP on SRS only,
 *  - the container fronting ingest (restarted mid-stream by the engine-restart scenario),
 *  - the lifecycle log markers the uploader emits (published/unpublished vs opening/closing).
 *
 * Everything downstream of the uploader (the catalog, the VOD finalize, the /health shape) is
 * engine-agnostic, so it stays in the shared scenarios untouched, with one exception since the reconnect window change: what
 * an encoder dropping does to the broadcast. On SRS the unpublish ends nothing: `noteDisconnect` in
 * `packages/stream-uploader/src/engines/srs.ts` holds the session, the orphan reaper finalizes it
 * once no media has arrived for `ORPHAN_REAP_MS`, and an encoder back inside that window resumes the
 * same recording. On OME the closing webhook still calls `stopStream` in
 * `packages/stream-uploader/src/engines/ome.ts`, so the broadcast finalizes at once.
 */

import { derivePublishKey, PUBLISH_KEY_PARAM } from '@swarm-hls-stream/shared/publishKey';

import { containerName, type E2EConfig, type EngineName } from '../config.js';
import { INGEST_SRT, type IngestProtocol, unsupportedIngestReason } from '../ingestProtocol.js';

/**
 * The key a publisher presents: `undefined` for the stream's own, `null` for none, or a key a suite chose instead,
 * such as one issued for another stream, to see it refused.
 */
export type PresentedKey = string | null | undefined;

/**
 * The key to put in the URL, or null for none. The stream's own is derived when the deployment authenticates
 * publishers, and there is none when it does not. See SEC-28.
 *
 * Keyed on `streamPath` because that is the stream id verbatim: the uploader derives against
 * `buildStreamId(app, stream)`, which is the same `<app>/<name>` string this suite dials. A scenario
 * publishing to a second stream therefore gets that stream's own key, not the default one's.
 */
function keyFor(cfg: E2EConfig, streamPath: string, presented: PresentedKey): string | null {
  if (presented !== undefined) {
    return presented;
  }
  return cfg.publishKeySecret ? derivePublishKey(cfg.publishKeySecret, streamPath) : null;
}

/**
 * `?key=<key>`, or empty for none.
 *
 * Every spelling below was measured against the pinned images on 2026-08-03 rather than read from
 * documentation, and they are not the same shape.
 */
function keyQuery(key: string | null): string {
  return key === null ? '' : `?${PUBLISH_KEY_PARAM}=${key}`;
}

type IngestUrlBuilder = (cfg: E2EConfig, streamPath: string, presented?: PresentedKey) => string;

interface EngineProfile {
  name: EngineName;
  /** The container fronting ingest — restarted mid-stream by the engine-restart scenario. */
  mediaContainer(cfg: E2EConfig): string;
  /** SRT ingest URL the publisher (ffmpeg/OBS stand-in) dials for `streamPath`. */
  srtIngestUrl: IngestUrlBuilder;
  /** RTMP ingest URL for `streamPath`, or null for an engine that takes no RTMP in this stack. */
  rtmpIngestUrl: IngestUrlBuilder | null;
  /** Uploader log line emitted when a broadcaster session begins. */
  publishedMarker: RegExp;
  /**
   * Uploader log line emitted when the broadcaster's publish ends, on a clean stop or a drop. On OME
   * the uploader's session ends with it. On SRS it does not: the session is held for the reconnect
   * window, so this marks the disconnect rather than the end of the broadcast.
   */
  unpublishedMarker: RegExp;
  /** How long to let the engine accept SRT again after a restart before the broadcaster reconnects. */
  reconnectGraceMs: number;
}

const SRS: EngineProfile = {
  name: 'srs',
  mediaContainer: (cfg) => containerName(cfg, 'srs'),
  // SRS's documented publish form; ffmpeg passes the literal '#!::r=...' streamid through to libsrt.
  // The key rides inside the `r=` value, which is where SRS looks for a query: measured on 2026-08-03,
  // `#!::r=live/demo?key=K,m=publish` arrives at the webhook as `param: "key=K"`, with **no** leading
  // `?`, unlike the same key over RTMP. Both `on_publish` and `on_unpublish` carry it.
  srtIngestUrl: (cfg, streamPath, presented) =>
    `srt://${cfg.publicHost}:${cfg.ports.srt}?streamid=#!::r=${streamPath}${keyQuery(
      keyFor(cfg, streamPath, presented),
    )},m=publish`,
  // The server and the stream key the admin hands a broadcaster for OBS, `rtmp://<host>:<port>/<app>` and
  // `<stream>?key=<key>` (`buildRtmpServer` and `buildRtmpStreamKey` in `packages/contracts/src/ingest.ts`), joined
  // into the one URL ffmpeg takes. Either way SRS receives the server as the connection's `tcUrl` and the stream key
  // as the stream published, and reports the key in `param` with its leading `?`.
  rtmpIngestUrl: (cfg, streamPath, presented) =>
    `rtmp://${cfg.publicHost}:${cfg.ports.rtmp}/${streamPath}${keyQuery(keyFor(cfg, streamPath, presented))}`,
  // The SOURCE session's lines only, never a rung's. These markers mean "the broadcaster's session
  // began or ended", and under a ladder the rung teardown starts BEFORE the source session has
  // finished dying: scenario K once reconnected on the first rung-unpublish and SRS dropped the new
  // publisher into the tail of the old session (found live 2026-08-27, ordering varies run to run).
  publishedMarker: /\[SRS\] (Stream published|Ladder source authenticated)/,
  unpublishedMarker: /\[SRS\] (Stream unpublished|Ladder source unpublished)/,
  reconnectGraceMs: 10_000,
};

const OME: EngineProfile = {
  name: 'ome',
  mediaContainer: (cfg) => cfg.omeContainer,
  srtIngestUrl: (cfg, streamPath, presented) => {
    // OME derives app/stream from the SRT streamid. The uploader's admission parser (parseAppStream)
    // reads app/stream from a full srt:// URL in the streamid, so we embed one, which holds whether
    // OME forwards the resolved path or the raw streamid to the admission webhook. Confirmed live in
    // the OME verification run.
    const endpoint = `srt://${cfg.publicHost}:${cfg.omeSrtPort}`;
    const key = keyFor(cfg, streamPath, presented);
    const inner = `${endpoint}/${streamPath}${keyQuery(key)}`;
    // Percent-encoded only when a key is present, which is deliberately not a uniform rule.
    //
    // The keyless form is left byte-for-byte as it was, because it is the one confirmed live in the
    // OME verification run and nothing here is worth regressing it for. The keyed form needs the
    // encoding: it puts a second `?` inside the outer URL's query value, and the encoded spelling is
    // the one measured working against real OME on 2026-08-03, which is also what
    // `deploy/scripts/publish-key.sh` prints for an operator to paste.
    return `${endpoint}?streamid=${key === null ? inner : encodeURIComponent(inner)}`;
  },
  rtmpIngestUrl: null,
  publishedMarker: /\[OME\] Stream opening/,
  unpublishedMarker: /\[OME\] Stream closing/,
  // OME's container cold-starts slower than SRS, so give the SRT provider longer to come back.
  reconnectGraceMs: 20_000,
};

const PROFILES: Record<EngineName, EngineProfile> = { srs: SRS, ome: OME };

export function getEngine(cfg: E2EConfig): EngineProfile {
  return PROFILES[cfg.engine];
}

/** SRT ingest URL for the configured engine and stream path (defaults to the profile's streamPath). */
export function srtIngestUrl(cfg: E2EConfig, streamPath: string = cfg.streamPath): string {
  return getEngine(cfg).srtIngestUrl(cfg, streamPath);
}

/**
 * The URL a publisher dials to send `streamPath` over `protocol`, presenting the stream's own key unless `presented`
 * names another or none. Refuses a protocol the configured engine does not take in this stack, rather than handing
 * back a URL nothing listens on.
 */
export function ingestUrl(
  cfg: E2EConfig,
  protocol: IngestProtocol,
  streamPath: string = cfg.streamPath,
  presented?: PresentedKey,
): string {
  const engine = getEngine(cfg);
  if (protocol === INGEST_SRT) {
    return engine.srtIngestUrl(cfg, streamPath, presented);
  }
  if (engine.rtmpIngestUrl === null) {
    throw new Error(unsupportedIngestReason(engine.name, protocol) ?? `${engine.name} takes no ${protocol} here`);
  }
  return engine.rtmpIngestUrl(cfg, streamPath, presented);
}

/**
 * A rung republish starting and ending on the ABR vhost, with the rung's stream id as capture group 1.
 *
 * Written by `packages/stream-uploader/src/engines/srs.ts` from each rung's own hook. SRS sends a rung's hooks only
 * when its encoder publishes or stops publishing, so a rung SRS holds through a short drop of its source, under the
 * encoder hold, writes neither line, and a rung SRS cut and restarted writes both.
 */
export const SRS_RUNG_PUBLISHED = /\[SRS\] Rung published: (\S+)/;
export const SRS_RUNG_UNPUBLISHED = /\[SRS\] Rung unpublished: (\S+)/;

/**
 * The uploader's word that a connection left while a newer one the hook had accepted for the same stream was still
 * there, with the stream id as capture group 1. That is the order a takeover produces: SRS asks the hook about the
 * new connection first and expires the old one after. A clean reconnect never writes it, because there the old
 * connection has left before the new one arrives.
 *
 * Written by `packages/stream-uploader/src/engines/srs.ts` for a single stream and for a ladder's source alike.
 */
export const SRS_OLD_CONNECTION_LEFT_AFTER_A_NEWER =
  /\[SRS\] (?:Stream|Ladder source) (\S+): a connection unpublished while another the hook accepted is still there/;

/** Every rung stream id a log names under `pattern`, one entry per line, in the order they were written. */
export function rungStreamsIn(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(new RegExp(pattern.source, 'g'))].map((match) => match[1]);
}
