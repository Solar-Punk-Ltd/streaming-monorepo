import type { MediaType } from './api.js';

/** What OBS needs to push over RTMP. */
export interface IngestRtmpDetails {
  /** OBS "Server". */
  server: string;
  /** OBS "Stream Key". */
  streamKey: string;
}

/** OBS's SRT settings for one stream on its stage. */
export interface IngestSrtDetails {
  /**
   * The SRT publish URL without the passphrase. What OBS's "Server" box
   * takes is `buildObsSrtServer(url, passphrase).server`.
   */
  url: string;
  passphrase: string | null;
}

/** The stage a stream's ingest details come from, as far as the OBS panel names it. */
export interface IngestStage {
  stageId: string;
  name: string;
  /** When the manager retired the stage, or null. A stream on it keeps its details. */
  retiredAt: string | null;
}

/**
 * OBS / encoder connection details for one stream, from the stage it is
 * broadcast on.
 *
 * The ingest stream id is `<app>/<stream>`: `app` is the media type because
 * swarm-hls-stream maps app 'audio' to audio and anything else to video, and
 * `stream` is the stream's topic UUID so the uploader can find the draft by
 * name later. The per-stream key rides in the `key=` query parameter, which
 * every uploader that takes streams from this admin verifies. The SRT
 * passphrase is one value for the stage's whole ingest server and comes as
 * its own field, which `buildObsSrtServer` puts on the Server line wherever
 * OBS can read it there.
 *
 * `stage`, `srt` and `rtmp` are null while the stream has no stage: there is
 * nowhere to send it yet, and the console says to pick one. The stream id and
 * the key are the stream's own and are always there.
 */
export interface IngestDetails {
  streamId: string;
  app: MediaType;
  stream: string;
  /** 32 hex chars, rotatable. */
  publishKey: string;
  publishKeyRotatedAt: string | null;
  stage: IngestStage | null;
  srt: IngestSrtDetails | null;
  /**
   * Null unless the stage's record says `rtmpPublic`. The manager says it on
   * no stage: RTMP is closed to the outside on every stage, so an RTMP address
   * would point the streamer at a port that refuses them, and SRT is the
   * ingest broadcasters use. RTMP carries no passphrase, so where a record
   * does say it, this stream key crosses the network as readable text.
   */
  rtmp: IngestRtmpDetails | null;
}

export {
  buildIngestStreamId,
  buildObsSrtServer,
  buildRtmpServer,
  buildRtmpStreamKey,
  buildSrtPublishUrl,
  OBS_SRT_PASSPHRASE_FIELD_HELP,
  type ObsSrtServer,
  rtmpUnencryptedWarning,
  type SrtPassphraseRoute,
} from '@streaming-monorepo/contracts';
