import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ADMIN_ERROR_STREAM_NOT_FOUND,
  ADMIN_ERROR_UNAUTHENTICATED,
  feedOwnerOf,
  ingestLookupAnswerSchema,
  renditionAnswerRungSchema,
  renditionReportAnswerSchema,
  sameFeedOwner,
} from './adminAnswers.js';

const DRAFT = {
  id: 'str_01',
  topic: 'declared-topic',
  owner: '0xowner',
  mediaType: 'video',
  title: 'A declared broadcast',
  status: 'draft',
  publishKey: 'declared-publish-key',
};

const RUNG = {
  name: '720p',
  width: 1280,
  height: 720,
  topic: 'rung-topic',
  bandwidth: 2_800_000,
  avgBandwidth: 2_400_000,
};

const MERGED = {
  stream: { id: 'str_01', status: 'live' },
  renditions: [RUNG],
  ladder: { finished: false, flippedToFinished: false, duration: null },
  feed: { owner: '0xowner', index: 7 },
};

const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;

describe("the admin's error codes a caller tells its answers apart by", () => {
  it('names an undeclared stream and a refused token', () => {
    assert.equal(ADMIN_ERROR_STREAM_NOT_FOUND, 'stream_not_found');
    assert.equal(ADMIN_ERROR_UNAUTHENTICATED, 'unauthenticated');
  });
});

describe('an ingest lookup answer, as the uploader reads it', () => {
  it('takes a declared stream of either media type and keeps every field it was sent', () => {
    assert.deepEqual(ingestLookupAnswerSchema.parse(DRAFT), DRAFT);
    assert.deepEqual(ingestLookupAnswerSchema.parse({ ...DRAFT, mediaType: 'audio', extra: 1 }), {
      ...DRAFT,
      mediaType: 'audio',
      extra: 1,
    });
  });

  it('refuses a missing or empty text field, and a media type it does not name', () => {
    for (const field of ['id', 'topic', 'owner', 'title', 'status', 'publishKey']) {
      const without: Record<string, unknown> = { ...DRAFT };
      delete without[field];
      assert.equal(accepts(ingestLookupAnswerSchema, without), false, `${field} missing`);
      assert.equal(accepts(ingestLookupAnswerSchema, { ...DRAFT, [field]: '' }), false, `${field} empty`);
      assert.equal(accepts(ingestLookupAnswerSchema, { ...DRAFT, [field]: 3 }), false, `${field} a number`);
    }
    for (const mediaType of ['VIDEO', 'hologram', undefined, null]) {
      assert.equal(accepts(ingestLookupAnswerSchema, { ...DRAFT, mediaType }), false, String(mediaType));
    }
  });

  it('takes a text field that is only a space, since it checks for text and not for content', () => {
    assert.equal(accepts(ingestLookupAnswerSchema, { ...DRAFT, title: ' ' }), true);
  });

  it('refuses a body that is no object', () => {
    for (const body of [null, undefined, 'draft', 3, [DRAFT]]) {
      assert.equal(accepts(ingestLookupAnswerSchema, body), false, String(body));
    }
  });
});

describe('one rung of a merged ladder, as the uploader reads it', () => {
  it('takes a rung still delivering, and a finished one with its index and duration', () => {
    assert.deepEqual(renditionAnswerRungSchema.parse(RUNG), RUNG);
    assert.deepEqual(renditionAnswerRungSchema.parse({ ...RUNG, index: 9, duration: 12 }), {
      ...RUNG,
      index: 9,
      duration: 12,
    });
  });

  it('keeps a field it does not know', () => {
    assert.deepEqual(renditionAnswerRungSchema.parse({ ...RUNG, codecs: 'avc1' }), { ...RUNG, codecs: 'avc1' });
  });

  it('refuses an empty name or topic, and a size or a bandwidth that is no finite number', () => {
    for (const change of [
      { name: '' },
      { topic: '' },
      { topic: undefined },
      { width: '1280' },
      { height: NaN },
      { bandwidth: Infinity },
      { avgBandwidth: -Infinity },
    ]) {
      assert.equal(accepts(renditionAnswerRungSchema, { ...RUNG, ...change }), false, JSON.stringify(change));
    }
  });

  it('takes a size that is negative or fractional, since it checks for a number and nothing more', () => {
    assert.equal(accepts(renditionAnswerRungSchema, { ...RUNG, width: -1, height: 720.5 }), true);
  });

  it('refuses an index without a duration, or the other way round, and either that is no number', () => {
    for (const change of [{ index: 9 }, { duration: 12 }, { index: '9', duration: 12 }, { index: 9, duration: null }]) {
      assert.equal(accepts(renditionAnswerRungSchema, { ...RUNG, ...change }), false, JSON.stringify(change));
    }
  });

  it('takes an index and a duration that are numbers of any kind, infinite and NaN included', () => {
    assert.equal(accepts(renditionAnswerRungSchema, { ...RUNG, index: NaN, duration: Infinity }), true);
  });
});

describe('a rung report answer, as the uploader reads it', () => {
  it('reads the rungs as sent, the ladder state, the stream status and the catalog write index', () => {
    assert.deepEqual(renditionReportAnswerSchema.parse(MERGED), {
      renditions: [RUNG],
      streamStatus: 'live',
      feedIndex: 7,
      ladder: { finished: false, flippedToFinished: false, duration: null },
    });
  });

  it('reads a finished ladder with its duration', () => {
    const finished = {
      ...MERGED,
      renditions: [{ ...RUNG, index: 9, duration: 12 }],
      ladder: { finished: true, flippedToFinished: true, duration: 12, extra: 1 },
    };
    assert.deepEqual(renditionReportAnswerSchema.parse(finished).ladder, {
      finished: true,
      flippedToFinished: true,
      duration: 12,
    });
  });

  it('answers null for a stream status or a catalog write index the body does not carry as it should', () => {
    for (const change of [
      { stream: undefined, feed: undefined },
      { stream: null, feed: null },
      { stream: { status: 3 }, feed: { index: '7' } },
      { stream: 'live', feed: 7 },
      { feed: { index: Infinity } },
      { feed: { index: NaN } },
    ]) {
      const read = renditionReportAnswerSchema.parse({ ...MERGED, ...change });
      assert.equal(read.feedIndex, null, JSON.stringify(change));
      if ('stream' in change) assert.equal(read.streamStatus, null, JSON.stringify(change));
    }
  });

  it('refuses rungs that are no list or hold a rung it refuses, and a ladder state that is not all there', () => {
    for (const change of [
      { renditions: undefined },
      { renditions: { '720p': RUNG } },
      { renditions: [{ ...RUNG, topic: undefined }] },
      { ladder: undefined },
      { ladder: { finished: 'no', flippedToFinished: false, duration: null } },
      { ladder: { finished: false, flippedToFinished: false } },
      { ladder: { finished: false, flippedToFinished: false, duration: '12' } },
    ]) {
      assert.equal(accepts(renditionReportAnswerSchema, { ...MERGED, ...change }), false, JSON.stringify(change));
    }
  });

  it('takes an empty list of rungs and an infinite ladder duration', () => {
    const read = renditionReportAnswerSchema.parse({
      ...MERGED,
      renditions: [],
      ladder: { finished: true, flippedToFinished: false, duration: Infinity },
    });
    assert.deepEqual(read.renditions, []);
    assert.equal(read.ladder.duration, Infinity);
  });

  it('refuses a body that is no object', () => {
    for (const body of [null, undefined, 'a merged ladder', 3, [MERGED]]) {
      assert.equal(accepts(renditionReportAnswerSchema, body), false, String(body));
    }
  });
});

describe("the feed owner off the admin's public config", () => {
  it('is the text at feed.owner', () => {
    assert.equal(feedOwnerOf({ feed: { owner: '0xabc', topic: 't' } }), '0xabc');
  });

  it('is null when the body carries no owner, an empty one, or one that is no text', () => {
    for (const body of [
      { feed: { owner: '' } },
      { feed: { owner: 3 } },
      { feed: { topic: 't' } },
      { feed: 'owner' },
      { feed: null },
      {},
      null,
      undefined,
      'nope',
      [],
    ]) {
      assert.equal(feedOwnerOf(body), null, JSON.stringify(body));
    }
  });
});

describe('two feed owners compared', () => {
  it('are one address whatever their case, a 0x prefix, and spaces around them', () => {
    assert.equal(sameFeedOwner('0xABcd', 'abcd'), true);
    assert.equal(sameFeedOwner(' abcd ', '0xABCD'), true);
    assert.equal(sameFeedOwner('0XABCD', 'abcd'), true);
  });

  it('differ when their digits do, or a prefix is doubled', () => {
    assert.equal(sameFeedOwner('abcd', 'abce'), false);
    assert.equal(sameFeedOwner('0x0xabcd', 'abcd'), false);
  });
});
