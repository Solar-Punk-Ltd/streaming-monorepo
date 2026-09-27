/**
 * The uploader's `/health` page, which the manager reads. It answers 200 only with `ok`, and its body carries the
 * status, the reasons, and while it waits for its node `waitingSince` and `node`, beside counters the manager does not
 * read. The page takes no credential, so nothing in it names a node's secret or a batch.
 */

export const UPLOADER_STATUS_OK = 'ok' as const;
export const UPLOADER_STATUS_DEGRADED = 'degraded' as const;
/** The boot has not finished, because the half of it that needs a Bee node is still waiting for one. */
export const UPLOADER_STATUS_WAITING_FOR_NODE = 'waiting_for_node' as const;

export const UPLOADER_HEALTH_STATUSES = [
  UPLOADER_STATUS_OK,
  UPLOADER_STATUS_DEGRADED,
  UPLOADER_STATUS_WAITING_FOR_NODE,
] as const;

export type UploaderHealthStatus = (typeof UPLOADER_HEALTH_STATUSES)[number];

export const UPLOADER_REASON_STALE_MANIFEST = 'stale_manifest' as const;
export const UPLOADER_REASON_SEGMENT_UPLOAD_FAILURE = 'segment_upload_failure' as const;
export const UPLOADER_REASON_QUEUE_PRESSURE = 'queue_pressure' as const;
export const UPLOADER_REASON_SEGMENT_STALL = 'segment_stall' as const;
export const UPLOADER_REASON_SEGMENT_LOSS = 'segment_loss' as const;
export const UPLOADER_REASON_UNLISTED_STREAM = 'unlisted_stream' as const;
export const UPLOADER_REASON_STATE_NOT_PERSISTED = 'state_not_persisted' as const;
export const UPLOADER_REASON_INGEST_REFUSED = 'ingest_refused' as const;
export const UPLOADER_REASON_UNRECOVERABLE_STREAM = 'unrecoverable_stream' as const;
export const UPLOADER_REASON_FRAGMENT_MISMATCH = 'fragment_mismatch' as const;
export const UPLOADER_REASON_FRAGMENT_PUBLISHER_GOP = 'fragment_publisher_gop' as const;
export const UPLOADER_REASON_POSTAGE_REFUSED = 'postage_refused' as const;
export const UPLOADER_REASON_NODE_UNAVAILABLE = 'node_unavailable' as const;
export const UPLOADER_REASON_START_GATE_WARNED = 'start_gate_warned' as const;

export const UPLOADER_HEALTH_REASONS = [
  UPLOADER_REASON_STALE_MANIFEST,
  UPLOADER_REASON_SEGMENT_UPLOAD_FAILURE,
  UPLOADER_REASON_QUEUE_PRESSURE,
  UPLOADER_REASON_SEGMENT_STALL,
  UPLOADER_REASON_SEGMENT_LOSS,
  UPLOADER_REASON_UNLISTED_STREAM,
  UPLOADER_REASON_STATE_NOT_PERSISTED,
  UPLOADER_REASON_INGEST_REFUSED,
  UPLOADER_REASON_UNRECOVERABLE_STREAM,
  UPLOADER_REASON_FRAGMENT_MISMATCH,
  UPLOADER_REASON_FRAGMENT_PUBLISHER_GOP,
  UPLOADER_REASON_POSTAGE_REFUSED,
  UPLOADER_REASON_NODE_UNAVAILABLE,
  UPLOADER_REASON_START_GATE_WARNED,
] as const;

export type UploaderHealthReason = (typeof UPLOADER_HEALTH_REASONS)[number];
