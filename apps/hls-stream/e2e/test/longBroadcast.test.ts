import { ladderFinalized, manifestUploaded } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_LONG_BROADCAST_MINUTES,
  finalizeSecondsAfterLastPublish,
  longBroadcastMinutes,
} from '../src/harness/longBroadcast.js';

describe('longBroadcastMinutes', () => {
  it('defaults to twenty minutes', () => {
    assert.equal(longBroadcastMinutes({}), DEFAULT_LONG_BROADCAST_MINUTES);
    assert.equal(longBroadcastMinutes({ E2E_LONG_BROADCAST_MINUTES: ' ' }), DEFAULT_LONG_BROADCAST_MINUTES);
  });

  it('takes a positive number', () => {
    assert.equal(longBroadcastMinutes({ E2E_LONG_BROADCAST_MINUTES: '30' }), 30);
  });

  it('refuses a typo rather than running a broadcast nobody asked for', () => {
    assert.throws(() => longBroadcastMinutes({ E2E_LONG_BROADCAST_MINUTES: '20m' }), /not a positive number/);
    assert.throws(() => longBroadcastMinutes({ E2E_LONG_BROADCAST_MINUTES: '0' }), /not a positive number/);
  });
});

describe('finalizeSecondsAfterLastPublish', () => {
  const line = (iso: string, message: string) => `[${iso}] [LOG] - ${message}`;

  it('measures from the last live playlist to this ladder flip, on the uploader clock', () => {
    const log = [
      line('2026-10-14T10:00:00.000Z', manifestUploaded('live/stream_360p', 1199)),
      line('2026-10-14T10:00:01.500Z', manifestUploaded('live/stream_1080p', 1199)),
      line('2026-10-14T10:00:30.000Z', ladderFinalized('group-b')),
      line('2026-10-14T10:00:43.500Z', ladderFinalized('group-a')),
    ].join('\n');
    assert.equal(finalizeSecondsAfterLastPublish(log, 'group-a'), 42);
  });

  it('answers null where the flip never came', () => {
    assert.equal(
      finalizeSecondsAfterLastPublish(line('2026-10-14T10:00:00.000Z', manifestUploaded('a', 0)), 'g'),
      null,
    );
  });
});
