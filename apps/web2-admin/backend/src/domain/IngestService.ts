import {
  buildIngestStreamId,
  buildRtmpServer,
  buildRtmpStreamKey,
  buildSrtPublishUrl,
  type IngestDetails,
  type IngestRtmpDetails,
} from '@streaming-monorepo/web2-admin-common';

import type { StageSecretsRow, StreamRow } from '../types/index.js';

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
 * How the ingest details read a stage: with its SRT passphrase, which only
 * one stream's details ever carry. StageRepository's `find`; a fake stands in.
 */
export interface IngestStageLookup {
  find(stageId: string): Promise<StageSecretsRow | null>;
}

/**
 * What the operator types into OBS, derived from the row and the stage it is
 * broadcast on, as the manager last pushed it: no network call. The manager
 * computed this in its frontend from port arithmetic; here it is one
 * server-side answer, so the console cannot disagree with what the uploader
 * will accept.
 *
 * The SRT passphrase is a property of the stage's ingest server, not of the
 * stream; the per-stream credential is `publishKey`, which rides in `key=`.
 * Without a stage there is nowhere to send the stream, and only the stream's
 * own id and key are answered.
 *
 * A stage the manager retired keeps its streams' details: a stream published
 * on it stays as it is.
 */
export function ingestDetailsFor(stream: StreamRow, stage: StageSecretsRow | null): IngestDetails {
  const app = stream.media_type;
  const streamId = buildIngestStreamId(app, stream.topic);
  const own = {
    streamId,
    app,
    stream: stream.topic,
    publishKey: stream.publish_key,
    publishKeyRotatedAt: stream.publish_key_rotated_at ? stream.publish_key_rotated_at.toISOString() : null,
  };
  if (!stage) return { ...own, stage: null, srt: null, rtmp: null };

  const { ingest } = stage.record;
  return {
    ...own,
    stage: {
      stageId: stage.stage_id,
      name: stage.name,
      retiredAt: stage.retired_observed_at ? stage.retired_observed_at.toISOString() : null,
    },
    srt: {
      url: buildSrtPublishUrl(ingest, streamId, stream.publish_key),
      passphrase: stage.srt_passphrase,
    },
    rtmp: ingest.rtmpPublic ? rtmpDetailsFor(stream, ingest) : null,
  };
}

/**
 * Only built where the stage opens RTMP ingest, so the stream key does not
 * travel a second time, in a form nobody can use, on a stage that closed it.
 */
function rtmpDetailsFor(stream: StreamRow, ingest: { host: string; rtmpPort: number }): IngestRtmpDetails {
  return {
    server: buildRtmpServer(ingest, stream.media_type),
    streamKey: buildRtmpStreamKey(stream.topic, stream.publish_key),
  };
}

export class IngestService {
  constructor(
    private readonly streams: IngestStreamStore,
    private readonly stages: IngestStageLookup,
    private readonly audit: AuditLog,
  ) {}

  async detailsFor(id: string): Promise<IngestDetails> {
    const stream = await this.streams.findById(id);
    if (!stream) throw new StreamNotFoundError(id);
    return ingestDetailsFor(stream, await this.stageOf(stream));
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
    return ingestDetailsFor(rotated, await this.stageOf(rotated));
  }

  private async stageOf(stream: StreamRow): Promise<StageSecretsRow | null> {
    return stream.stage_id ? this.stages.find(stream.stage_id) : null;
  }
}
