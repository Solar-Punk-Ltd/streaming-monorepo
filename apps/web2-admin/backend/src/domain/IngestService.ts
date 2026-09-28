import {
  buildIngestStreamId,
  buildRtmpServer,
  buildRtmpStreamKey,
  buildSrtPublishUrl,
  type IngestDetails,
  type IngestRtmpDetails,
} from '@streaming-monorepo/web2-admin-common';

import type { StreamRow } from '../types/index.js';
import type { IngestConfig } from '../utils/config.js';

import { describeActor, describeStream, type Actor } from './actor.js';
import { recordAudit, type AuditLog } from './AuditLog.js';
import { StreamNotFoundError } from './errors/index.js';
import { Logger } from './Logger.js';
import { newPublishKey } from './StreamService.js';

const logger = Logger.getInstance();

/** The slice of StreamRepository the ingest details need; a fake stands in. */
export interface IngestStreamStore {
  findById(id: string): Promise<StreamRow | null>;
  rotatePublishKey(id: string, publishKey: string): Promise<StreamRow | null>;
}

/**
 * What the operator types into OBS, derived from the row and the configured
 * SRS endpoint — no network call, no state. The manager computed this in its
 * frontend from port arithmetic; here it is one server-side answer, so the
 * console cannot disagree with what the uploader will accept.
 *
 * The SRT passphrase is a property of the SRS server, not of the stream; the
 * per-stream credential is `publishKey`, which rides in `key=`.
 */
export function ingestDetailsFor(stream: StreamRow, endpoint: IngestConfig): IngestDetails {
  const app = stream.media_type;
  const streamId = buildIngestStreamId(app, stream.topic);
  return {
    streamId,
    app,
    stream: stream.topic,
    publishKey: stream.publish_key,
    publishKeyRotatedAt: stream.publish_key_rotated_at ? stream.publish_key_rotated_at.toISOString() : null,
    srt: {
      url: buildSrtPublishUrl(endpoint, streamId, stream.publish_key),
      passphrase: endpoint.srtPassphrase,
    },
    rtmp: endpoint.rtmpPublic ? rtmpDetailsFor(stream, endpoint) : null,
    keyVerified: endpoint.keyVerified,
  };
}

/**
 * Only built where RTMP ingest is open, so the stream key does not travel a
 * second time, in a form nobody can use, on a deployment that closed it.
 */
function rtmpDetailsFor(stream: StreamRow, endpoint: IngestConfig): IngestRtmpDetails {
  return {
    server: buildRtmpServer(endpoint, stream.media_type),
    streamKey: buildRtmpStreamKey(stream.topic, stream.publish_key),
  };
}

export class IngestService {
  constructor(
    private readonly streams: IngestStreamStore,
    private readonly endpoint: IngestConfig,
    private readonly audit: AuditLog,
  ) {}

  async detailsFor(id: string): Promise<IngestDetails> {
    const stream = await this.streams.findById(id);
    if (!stream) throw new StreamNotFoundError(id);
    return ingestDetailsFor(stream, this.endpoint);
  }

  /**
   * A new key invalidates whatever the streamer was given. Allowed in any
   * status: the point of rotating is that the old one leaked.
   *
   * Neither key reaches the log or the audit row, for the same reason.
   */
  async rotateKey(actor: Actor, id: string): Promise<IngestDetails> {
    const rotated = await this.streams.rotatePublishKey(id, newPublishKey());
    if (!rotated) throw new StreamNotFoundError(id);

    logger.info(`[Ingest] ${describeActor(actor)} rotated the publish key of ${describeStream(rotated)}`);
    await recordAudit(this.audit, {
      actor,
      action: 'stream.key.rotate',
      streamId: rotated.id,
      topic: rotated.topic,
      statusBefore: rotated.status,
      statusAfter: rotated.status,
    });
    return ingestDetailsFor(rotated, this.endpoint);
  }
}
