import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RECORDING_CHECK_ROUND_GAP_SECONDS,
  RECORDING_CHECK_ROUNDS,
  type RecordingJudgeInput,
  recordingSkipReason,
  recordingVerdict,
} from './lostRecordings.js';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const stream = (over: Partial<RecordingJudgeInput> = {}): RecordingJudgeInput => ({
  status: 'vod',
  restartUntil: null,
  hasOpenJob: false,
  ...over,
});

describe('which stream a check may judge', () => {
  it('judges a recording that has ended for good and that nothing else reads', () => {
    assert.equal(recordingSkipReason(stream(), NOW), null);
    assert.equal(recordingSkipReason(stream({ status: 'draft' }), NOW), null);
    assert.equal(recordingSkipReason(stream({ restartUntil: '2026-11-19T11:59:59.000Z' }), NOW), null);
    assert.equal(recordingSkipReason(stream({ test: false }), NOW), null);
  });

  it('leaves out a live stream, one inside its restart window and one with a job under way', () => {
    assert.equal(recordingSkipReason(stream({ status: 'live' }), NOW), 'live');
    assert.equal(recordingSkipReason(stream({ restartUntil: '2026-11-19T12:00:01.000Z' }), NOW), 'restart_window');
    assert.equal(recordingSkipReason(stream({ hasOpenJob: true }), NOW), 'job');
  });

  it('never judges a test stream, whatever else is true of it', () => {
    assert.equal(recordingSkipReason(stream({ test: true }), NOW), 'test');
    assert.equal(recordingSkipReason(stream({ test: true, status: 'live', hasOpenJob: true }), NOW), 'test');
  });
});

describe('what the readings say of a recording', () => {
  const yes = [true];
  const no = [false, false, false];

  it('reads three rounds, ten minutes apart', () => {
    assert.equal(RECORDING_CHECK_ROUNDS, 3);
    assert.equal(RECORDING_CHECK_ROUND_GAP_SECONDS, 600);
  });

  it('is readable when the master and every quality were read in some round', () => {
    assert.equal(recordingVerdict({ master: yes, qualities: [{ name: '1080p', rounds: yes }] }), 'readable');
    const late = { master: [false, true], qualities: [{ name: '1080p', rounds: [false, false, true] }] };
    assert.equal(recordingVerdict(late), 'readable');
  });

  it('is lost when the master failed in every round, or every quality did', () => {
    assert.equal(recordingVerdict({ master: no, qualities: [] }), 'lost');
    assert.equal(recordingVerdict({ master: no, qualities: [{ name: '1080p', rounds: yes }] }), 'lost');
    const all = {
      master: yes,
      qualities: [
        { name: '1080p', rounds: no },
        { name: '360p', rounds: no },
      ],
    };
    assert.equal(recordingVerdict(all), 'lost');
    assert.equal(recordingVerdict({ master: yes, qualities: [{ name: 'stream', rounds: no }] }), 'lost');
  });

  it('is partly lost when some quality failed in every round and another was read', () => {
    const some = {
      master: yes,
      qualities: [
        { name: '1080p', rounds: no },
        { name: '360p', rounds: yes },
      ],
    };
    assert.equal(recordingVerdict(some), 'partly_lost');
  });

  it('counts a failure only once every round is over', () => {
    const early = { master: yes, qualities: [{ name: '1080p', rounds: [false, false] }] };
    assert.equal(recordingVerdict(early), 'readable');
    assert.equal(recordingVerdict({ master: [false, false], qualities: [] }), 'readable');
  });
});
