import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ingestLookupParamsSchema,
  ingestLookupPath,
  renditionReportSchema,
  streamStateReportSchema,
  UUID_PATTERN,
} from './adminApi.js';

const TOPIC = '1867808f-7b1c-4e46-b437-f7423b466b39';
const RUNG = { name: '720p', width: 1280, height: 720, topic: TOPIC, bandwidth: 2_800_000, avgBandwidth: 2_500_000 };
/** A made-up Swarm reference, built rather than written out. */
const RECORDING = 'ab'.repeat(32);

const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;

describe('a UUID, as the admin names streams and topics', () => {
  it('is 8-4-4-4-12 hex digits in either case, of any version', () => {
    assert.match(TOPIC, UUID_PATTERN);
    assert.match(TOPIC.toUpperCase(), UUID_PATTERN);
    assert.match('00000000-0000-0000-0000-000000000000', UUID_PATTERN);
    assert.doesNotMatch(`${TOPIC} `, UUID_PATTERN);
    assert.doesNotMatch(TOPIC.replaceAll('-', ''), UUID_PATTERN);
  });
});

describe('the ingest lookup address', () => {
  it('is the internal route with the ingest id after it, each segment percent-encoded', () => {
    assert.equal(
      ingestLookupPath('video/00000000-0000-0000-0000-000000000000'),
      '/api/internal/streams/by-ingest/video/00000000-0000-0000-0000-000000000000',
    );
    assert.equal(ingestLookupPath('video/demo'), '/api/internal/streams/by-ingest/video/demo');
    assert.equal(ingestLookupPath('a b/c?d#e'), '/api/internal/streams/by-ingest/a%20b/c%3Fd%23e');
    assert.equal(ingestLookupPath('video/../x'), '/api/internal/streams/by-ingest/video/../x');
    assert.equal(ingestLookupPath('/video//x/'), '/api/internal/streams/by-ingest//video//x/');
    assert.equal(ingestLookupPath(''), '/api/internal/streams/by-ingest/');
  });

  it('takes a media type and a UUID', () => {
    assert.deepEqual(ingestLookupParamsSchema.parse({ app: 'audio', stream: TOPIC }), { app: 'audio', stream: TOPIC });
  });

  it('refuses an application that is no media type, in any case, and a stream that is no UUID', () => {
    assert.equal(accepts(ingestLookupParamsSchema, { app: 'VIDEO', stream: TOPIC }), false);
    assert.equal(accepts(ingestLookupParamsSchema, { app: 'text', stream: TOPIC }), false);
    assert.equal(accepts(ingestLookupParamsSchema, { app: 'video', stream: "' OR 1=1 --" }), false);
  });
});

describe('a state report, as the admin reads it', () => {
  it('takes live alone, and an ended broadcast with the reference of its recording and its duration', () => {
    assert.deepEqual(streamStateReportSchema.parse({ state: 'live' }), { state: 'live' });
    assert.deepEqual(streamStateReportSchema.parse({ state: 'vod', recording: RECORDING, duration: 12.5 }), {
      state: 'vod',
      recording: RECORDING,
      duration: 12.5,
    });
  });

  it('refuses a recording without its reference or its duration, and live with either', () => {
    assert.equal(accepts(streamStateReportSchema, { state: 'vod', recording: RECORDING }), false);
    assert.equal(accepts(streamStateReportSchema, { state: 'vod', duration: 1 }), false);
    assert.equal(accepts(streamStateReportSchema, { state: 'live', recording: RECORDING }), false);
    assert.equal(accepts(streamStateReportSchema, { state: 'live', duration: 1 }), false);
  });

  it('refuses a feed index, with or without a reference beside it', () => {
    for (const value of [
      { state: 'vod', index: 3, duration: 1 },
      { state: 'vod', recording: RECORDING, index: 3, duration: 1 },
      { state: 'live', index: 3 },
      { state: 'live', index: null },
    ]) {
      assert.equal(accepts(streamStateReportSchema, value), false, JSON.stringify(value));
    }
  });

  it('refuses another state, a negative duration, and a body that is no object', () => {
    for (const value of [
      { state: 'LIVE' },
      { state: 'scheduled' },
      { state: 5 },
      { state: 'vod', recording: RECORDING, duration: -1 },
      null,
      ['live'],
      'live',
    ]) {
      assert.equal(accepts(streamStateReportSchema, value), false, JSON.stringify(value));
    }
  });

  it('drops a field it does not know rather than refusing it, as the admin always has', () => {
    assert.deepEqual(streamStateReportSchema.parse({ state: 'live', extra: 1 }), { state: 'live' });
  });

  it('reads a duration sent as text or as a one-element list as that number, as the admin always has', () => {
    assert.equal(streamStateReportSchema.parse({ state: 'vod', recording: RECORDING, duration: '12.5' }).duration, 12.5);
    assert.equal(streamStateReportSchema.parse({ state: 'vod', recording: RECORDING, duration: [3] }).duration, 3);
  });

  it('refuses a duration that is no number, an empty one, and true', () => {
    for (const duration of ['', 'three', true]) {
      assert.equal(
        accepts(streamStateReportSchema, { state: 'vod', recording: RECORDING, duration }),
        false,
        String(duration),
      );
    }
  });

  it('lets an infinite duration through, as the admin always has', () => {
    assert.equal(
      streamStateReportSchema.parse({ state: 'vod', recording: RECORDING, duration: Infinity }).duration,
      Infinity,
    );
  });

  it('refuses a reference that is not 64 lowercase hex digits', () => {
    for (const recording of [RECORDING.toUpperCase(), RECORDING.slice(2), `${RECORDING}aa`]) {
      assert.equal(accepts(streamStateReportSchema, { state: 'vod', recording, duration: 1 }), false, recording);
    }
  });
});

describe('a rung report, as the admin reads it', () => {
  it('takes a rung still delivering, and a finished one with the reference of its recording and its duration', () => {
    assert.deepEqual(renditionReportSchema.parse(RUNG), RUNG);
    assert.deepEqual(renditionReportSchema.parse({ ...RUNG, recording: RECORDING, duration: 30 }), {
      ...RUNG,
      recording: RECORDING,
      duration: 30,
    });
  });

  it('refuses a reference without its duration, or the other way round', () => {
    assert.equal(accepts(renditionReportSchema, { ...RUNG, recording: RECORDING }), false);
    assert.equal(accepts(renditionReportSchema, { ...RUNG, duration: 1 }), false);
  });

  it('refuses a feed index, with or without a reference beside it', () => {
    assert.equal(accepts(renditionReportSchema, { ...RUNG, index: 0, duration: 0 }), false);
    assert.equal(accepts(renditionReportSchema, { ...RUNG, recording: RECORDING, index: 3, duration: 30 }), false);
  });

  it('refuses a name with an underscore, a space or over 32 characters, and a topic that is no UUID', () => {
    for (const change of [
      { name: '720_p' },
      { name: ' 720p' },
      { name: 'a'.repeat(33) },
      { name: '' },
      { topic: 'rung-topic' },
    ]) {
      assert.equal(accepts(renditionReportSchema, { ...RUNG, ...change }), false, JSON.stringify(change));
    }
  });

  it('refuses a size that is not a whole positive number and a bandwidth below zero', () => {
    for (const change of [
      { width: 0 },
      { height: 720.5 },
      { bandwidth: -1 },
      { avgBandwidth: 1.5 },
      { width: Infinity },
      { recording: RECORDING, duration: -1 },
    ]) {
      assert.equal(accepts(renditionReportSchema, { ...RUNG, ...change }), false, JSON.stringify(change));
    }
  });

  it('refuses a missing field', () => {
    for (const field of Object.keys(RUNG)) {
      const rung: Record<string, unknown> = { ...RUNG };
      delete rung[field];
      assert.equal(accepts(renditionReportSchema, rung), false, field);
    }
  });

  it('reads a number sent as text and a name sent as a number, and drops a field it does not know', () => {
    assert.deepEqual(renditionReportSchema.parse({ ...RUNG, width: '1280', name: 720, extra: true }), {
      ...RUNG,
      name: '720',
    });
  });
});
