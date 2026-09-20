import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ContinuationOperation,
  LegacyAdoptionOperation,
} from '@streaming-monorepo/web2-admin-common';

import {
  toOwnerContinuation,
  toOwnerLegacyAdoption,
} from '../../src/api/routes/streams.js';

describe('owner continuation presentation', () => {
  it('strips uploader storage proof while retaining owner operation state', () => {
    const operation: ContinuationOperation = {
      lifecycleVersion: 1,
      operationId: '88888888-8888-4888-8888-888888888888',
      requestId: '77777777-7777-4777-8777-777777777777',
      streamId: '22222222-2222-4222-8222-222222222222',
      topic: '11111111-1111-4111-8111-111111111111',
      mediaType: 'video',
      uploaderId: 'srs-157-90-34-105',
      previousRunNumber: 2,
      nextRunNumber: 3,
      revision: 14,
      status: 'pending',
      previousEmptyOutcome: {
        runNumber: 2,
        checkpointReference: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        acceptedMediaCount: 0,
      },
      retainedRecording: {
        runNumber: 1,
        checkpointReference: '99999999-9999-4999-8999-999999999999',
        master: {
          topic: '11111111-1111-4111-8111-111111111111',
          index: 32,
          reference: 'fixture-master-reference',
          duration: 724.5,
        },
        expectedRenditions: [],
        renditions: [],
      },
    };

    assert.deepEqual(toOwnerContinuation(operation), {
      lifecycleVersion: 1,
      operationId: operation.operationId,
      requestId: operation.requestId,
      streamId: operation.streamId,
      topic: operation.topic,
      mediaType: operation.mediaType,
      previousRunNumber: 2,
      nextRunNumber: 3,
      revision: 14,
      status: 'pending',
    });
  });
});

describe('owner legacy adoption presentation', () => {
  it('strips the uploader candidate, checkpoint and media proof', () => {
    const operation = {
      lifecycleVersion: 1,
      kind: 'legacy-adoption',
      operationId: '88888888-8888-4888-8888-888888888888',
      requestId: '77777777-7777-4777-8777-777777777777',
      streamId: '22222222-2222-4222-8222-222222222222',
      topic: '11111111-1111-4111-8111-111111111111',
      mediaType: 'video',
      uploaderId: 'srs-uploader-a',
      candidateDigest: 'a'.repeat(64),
      revision: 2,
      status: 'committed',
      candidate: {
        streamId: '22222222-2222-4222-8222-222222222222',
        topic: '11111111-1111-4111-8111-111111111111',
        mediaType: 'video',
        master: {
          topic: '11111111-1111-4111-8111-111111111111',
          index: 12,
          duration: 62.5,
        },
        renditions: [],
      },
      completedRecording: {
        runNumber: 1,
        checkpointReference: '99999999-9999-4999-8999-999999999999',
        master: {
          topic: '11111111-1111-4111-8111-111111111111',
          index: 12,
          reference: 'b'.repeat(64),
          duration: 62.5,
        },
        expectedRenditions: [],
        renditions: [],
      },
      validation: {
        version: 1,
        mediaReadable: true,
        pendingWrites: 0,
        tracks: [],
      },
    } satisfies LegacyAdoptionOperation;

    assert.deepEqual(toOwnerLegacyAdoption(operation), {
      lifecycleVersion: 1,
      kind: 'legacy-adoption',
      operationId: operation.operationId,
      requestId: operation.requestId,
      streamId: operation.streamId,
      topic: operation.topic,
      mediaType: operation.mediaType,
      candidateDigest: operation.candidateDigest,
      revision: 2,
      status: 'committed',
    });
  });
});
