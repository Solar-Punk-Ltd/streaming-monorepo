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

export {
  buildIngestStreamId,
  buildObsSrtServer,
  buildRtmpServer,
  buildRtmpStreamKey,
  buildSrtPublishUrl,
  OBS_SRT_PASSPHRASE_FIELD_HELP,
  type ObsSrtServer,
  type SrtPassphraseRoute,
} from '@streaming-monorepo/contracts';
