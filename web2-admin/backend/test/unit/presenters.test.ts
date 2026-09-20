import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toStream } from '../../src/api/presenters.js';
import { streamRow } from './support/fakes.js';

describe('stream presentation', () => {
  it('includes managed status and the latest completed replay for the owner', () => {
    const row = streamRow({
      lifecycle_version: 1,
      lifecycle_revision: 12,
      current_run_number: 2,
      completed_run_number: 1,
      lifecycle_state: 'closed',
      lifecycle_permission: 'closed',
    });
    const completedRecording = {
      runNumber: 1,
      master: {
        topic: row.topic,
        index: 32,
        reference: 'fixture-master-reference',
        duration: 724.5,
      },
      expectedRenditions: [],
      renditions: [],
    };

    const presented = toStream(row, {
      lifecycle: {
        version: 1,
        revision: 12,
        runNumber: 2,
        state: 'closed',
        permission: 'closed',
        receivedAt: '2026-09-20T10:00:00.000Z',
      },
      completedRecording,
    });

    assert.deepEqual(presented.lifecycle, {
      version: 1,
      revision: 12,
      runNumber: 2,
      state: 'closed',
      permission: 'closed',
      receivedAt: '2026-09-20T10:00:00.000Z',
    });
    assert.equal(presented.completedRecording, completedRecording);
  });
});
