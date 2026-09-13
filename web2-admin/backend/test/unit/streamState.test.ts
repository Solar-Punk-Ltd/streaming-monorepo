/**
 * The rules the uploader's reports run into. Unit test — pure functions, no
 * database and no HTTP.
 *
 * A report is fire-and-forget: the uploader retries a failed one and never
 * stops the stream over it, so the same report arrives twice more often than
 * not. What must hold is that a repeat changes nothing and that an impossible
 * move is refused rather than quietly applied — a `live` for a draft nobody
 * has been told about would put a stream on the catalogue that no console
 * action ever published.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StreamStatus } from '@streaming-monorepo/web2-admin-common';

import { InvalidStateTransitionError } from '../../src/domain/errors/index.js';
import {
  allowedFromFor,
  hasGoneLive,
  isScheduleLocked,
  isStateTransitionAllowed,
  type ReportedState,
} from '../../src/domain/streamState.js';

import { streamRow } from './support/fakes.js';

const STATUSES: StreamStatus[] = [
  'draft',
  'publishing',
  'published',
  'live',
  'vod',
];

describe('isStateTransitionAllowed', () => {
  it('accepts the reports a normal broadcast makes', () => {
    assert.equal(isStateTransitionAllowed('published', 'live'), true);
    assert.equal(isStateTransitionAllowed('live', 'vod'), true);
  });

  it('accepts a repeated report, because the uploader retries', () => {
    assert.equal(isStateTransitionAllowed('live', 'live'), true);
    assert.equal(isStateTransitionAllowed('vod', 'vod'), true);
  });

  it('accepts a vod for a stream whose live report never arrived', () => {
    // The admin API was restarting while the encoder connected. The recording
    // still exists, and refusing it would leave the catalogue advertising a
    // stream that is scheduled forever.
    assert.equal(isStateTransitionAllowed('published', 'vod'), true);
  });

  it('refuses a stream that was never announced', () => {
    assert.equal(isStateTransitionAllowed('draft', 'live'), false);
    assert.equal(isStateTransitionAllowed('draft', 'vod'), false);
  });

  it('refuses a stream with a feed write in flight', () => {
    // The publish that claimed it may still fail back to `draft`.
    assert.equal(isStateTransitionAllowed('publishing', 'live'), false);
    assert.equal(isStateTransitionAllowed('publishing', 'vod'), false);
  });

  it('refuses resuming a finished recording', () => {
    // The next broadcast is a new publish, not a continuation of this one.
    assert.equal(isStateTransitionAllowed('vod', 'live'), false);
  });

  it('agrees with the status list the SQL transition is conditioned on', () => {
    // The rule is checked twice: once to answer 409, once inside the UPDATE so
    // two reports racing cannot both win. They must say the same thing.
    for (const state of ['live', 'vod'] as ReportedState[]) {
      for (const status of STATUSES) {
        assert.equal(
          allowedFromFor(state).includes(status),
          isStateTransitionAllowed(status, state),
          `${status} -> ${state}`,
        );
      }
    }
  });

  it('names both ends in the error the API answers with', () => {
    const error = new InvalidStateTransitionError('an-id', 'draft', 'live');
    assert.equal(error.from, 'draft');
    assert.equal(error.to, 'live');
  });
});

describe('hasGoneLive', () => {
  it('is the two states an encoder has already reached', () => {
    assert.deepEqual(
      STATUSES.filter(hasGoneLive),
      ['live', 'vod'],
    );
  });
});

describe('isScheduleLocked', () => {
  const scheduled = new Date('2026-10-01T09:00:00.000Z');

  it('lets a draft and a published stream be rescheduled', () => {
    for (const status of ['draft', 'published'] as StreamStatus[]) {
      const stream = streamRow({ status, scheduled_start_time: scheduled });
      assert.equal(
        isScheduleLocked(stream, '2026-11-02T09:00:00.000Z'),
        false,
        status,
      );
    }
  });

  it('locks a stream that has gone live or been recorded', () => {
    for (const status of ['live', 'vod'] as StreamStatus[]) {
      const stream = streamRow({ status, scheduled_start_time: scheduled });
      assert.equal(
        isScheduleLocked(stream, '2026-11-02T09:00:00.000Z'),
        true,
        status,
      );
    }
  });

  it('is not triggered by an edit that keeps the schedule', () => {
    // The console PUTs the whole StreamInput back on every save, so the
    // unchanged value arrives with every title fix made mid-broadcast.
    const live = streamRow({ status: 'live', scheduled_start_time: scheduled });
    assert.equal(isScheduleLocked(live, '2026-10-01T09:00:00.000Z'), false);
    assert.equal(
      isScheduleLocked(live, '2026-10-01T11:00:00.000+02:00'),
      false,
      'the same instant written in another zone is not a change',
    );
  });

  it('treats clearing or setting the schedule as a change', () => {
    const live = streamRow({ status: 'live', scheduled_start_time: scheduled });
    assert.equal(isScheduleLocked(live, null), true);

    const never = streamRow({ status: 'vod', scheduled_start_time: null });
    assert.equal(isScheduleLocked(never, '2026-10-01T09:00:00.000Z'), true);
    assert.equal(isScheduleLocked(never, null), false);
  });
});
