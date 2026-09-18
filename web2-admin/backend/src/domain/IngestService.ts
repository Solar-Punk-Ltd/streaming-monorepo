import {
  buildIngestStreamId,
  buildRtmpServer,
  buildRtmpStreamKey,
  buildSrtPublishUrl,
  type IngestDetails,
} from '@streaming-monorepo/web2-admin-common';

import type { StreamRow } from '../types/index.js';
import type { IngestConfig } from '../utils/config.js';

import { StreamNotFoundError } from './errors/index.js';
import { newPublishKey } from './StreamService.js';
import { StreamRepository } from './StreamRepository.js';

/**
 * What the operator types into OBS, derived from the row and the configured
 * SRS endpoint — no network call, no state. The manager computed this in its
 * frontend from port arithmetic; here it is one server-side answer, so the
 * console cannot disagree with what the uploader will accept.
 *
 * The SRT passphrase is a property of the SRS server, not of the stream; the
 * per-stream credential is `publishKey`, which rides in `key=`.
 */
export function ingestDetailsFor(
  stream: StreamRow,
  endpoint: IngestConfig,
): IngestDetails {
  const app = stream.media_type;
  const streamId = buildIngestStreamId(app, stream.topic);
  return {
    streamId,
    app,
    stream: stream.topic,
    publishKey: stream.publish_key,
    publishKeyRotatedAt: stream.publish_key_rotated_at
      ? stream.publish_key_rotated_at.toISOString()
      : null,
    srt: {
      url: buildSrtPublishUrl(endpoint, streamId, stream.publish_key),
      passphrase: endpoint.srtPassphrase,
    },
    rtmp: {
      server: buildRtmpServer(endpoint, app),
      streamKey: buildRtmpStreamKey(stream.topic, stream.publish_key),
    },
    keyVerified: endpoint.keyVerified,
  };
}

export class IngestService {
  constructor(
    private readonly streams: StreamRepository,
    private readonly endpoint: IngestConfig,
  ) {}

  async detailsFor(id: string): Promise<IngestDetails> {
    const stream = await this.streams.findById(id);
    if (!stream) throw new StreamNotFoundError(id);
    return ingestDetailsFor(stream, this.endpoint);
  }

  /**
   * A new key invalidates whatever the streamer was given. Allowed in any
   * status: the point of rotating is that the old one leaked.
   */
  async rotateKey(id: string): Promise<IngestDetails> {
    const rotated = await this.streams.rotatePublishKey(id, newPublishKey());
    if (!rotated) throw new StreamNotFoundError(id);
    return ingestDetailsFor(rotated, this.endpoint);
  }
}
