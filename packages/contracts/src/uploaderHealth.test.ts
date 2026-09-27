import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  UPLOADER_HEALTH_REASONS,
  UPLOADER_HEALTH_STATUSES,
  UPLOADER_REASON_NODE_UNAVAILABLE,
  UPLOADER_REASON_START_GATE_WARNED,
  UPLOADER_STATUS_WAITING_FOR_NODE,
} from './uploaderHealth.js';

describe("the uploader's health page", () => {
  it('says ok, degraded or waiting for its node', () => {
    assert.deepEqual(UPLOADER_HEALTH_STATUSES, ['ok', 'degraded', 'waiting_for_node']);
    assert.equal(UPLOADER_STATUS_WAITING_FOR_NODE, 'waiting_for_node');
  });

  it('names each reason with one of fourteen words', () => {
    assert.deepEqual(UPLOADER_HEALTH_REASONS, [
      'stale_manifest',
      'segment_upload_failure',
      'queue_pressure',
      'segment_stall',
      'segment_loss',
      'unlisted_stream',
      'state_not_persisted',
      'ingest_refused',
      'unrecoverable_stream',
      'fragment_mismatch',
      'fragment_publisher_gop',
      'postage_refused',
      'node_unavailable',
      'start_gate_warned',
    ]);
    assert.equal(UPLOADER_REASON_NODE_UNAVAILABLE, 'node_unavailable');
    assert.equal(UPLOADER_REASON_START_GATE_WARNED, 'start_gate_warned');
  });
});
