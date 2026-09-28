import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  feedOwnerOf,
  ingestLookupAnswerSchema,
  ingestLookupPath,
  renditionReportAnswerSchema,
  sameFeedOwner,
} from '@swarm-hls-stream/shared';

import {
  asDraft,
  asRenditionReport,
  feedOwnerOfConfig,
  lookupPath,
  sameFeedOwner as handWrittenSameFeedOwner,
} from './helpers/handWrittenAdminAnswers.js';

/**
 * The contract reads every admin answer the uploader reads, and reads it to the same value, as the hand-written
 * readers in `helpers/handWrittenAdminAnswers.ts` did.
 *
 * Measured, not argued: every field of a valid answer, and every field of each object nested in it, is swapped for
 * every value in a palette of the shapes a JSON body can carry and a few it cannot, is left out, and the body itself
 * is swapped for every value in the palette. Both readings are compared value for value.
 */

const PALETTE: unknown[] = [
  undefined,
  null,
  '',
  ' ',
  '0',
  '3',
  ' 3 ',
  'abc',
  'live',
  'video',
  'audio',
  'VIDEO',
  'x',
  [],
  [3],
  ['3'],
  [{}],
  {},
  { value: 3 },
  { status: 'live' },
  { index: 3 },
  { owner: '0xabc' },
  true,
  false,
  0,
  -0,
  1,
  3,
  3.5,
  -1,
  1e21,
  Infinity,
  -Infinity,
  NaN,
];

const DRAFT = {
  id: 'str_01',
  topic: 'declared-topic',
  owner: '0xowner',
  mediaType: 'video',
  title: 'A declared broadcast',
  status: 'draft',
  publishKey: 'declared-publish-key',
};

const RUNG = { name: '720p', width: 1280, height: 720, topic: 'rung-topic', bandwidth: 2_800_000, avgBandwidth: 0 };
const FINISHED_RUNG = { ...RUNG, index: 9, duration: 12 };

const MERGED = {
  stream: { id: 'str_01', status: 'live' },
  renditions: [RUNG, FINISHED_RUNG],
  ladder: { finished: false, flippedToFinished: false, duration: null },
  feed: { owner: '0xowner', index: 7 },
};

type Reading = { accepted: true; value: unknown } | { accepted: false };

function handWrittenReading(read: (body: unknown) => unknown, input: unknown): Reading {
  const value = read(input);
  return value === null ? { accepted: false } : { accepted: true, value };
}

function contractReading(schema: { safeParse(input: unknown): { success: boolean; data?: unknown } }, input: unknown) {
  const result = schema.safeParse(input);
  return result.success ? ({ accepted: true, value: result.data } as const) : ({ accepted: false } as const);
}

function label(input: unknown): string {
  return JSON.stringify(input, (_key, value: unknown) =>
    value === undefined || (typeof value === 'number' && !Number.isFinite(value)) || Object.is(value, -0)
      ? `<${String(Object.is(value, -0) ? '-0' : value)}>`
      : value,
  );
}

/** `base` with `field` given every value in the palette, and with it left out. */
function eachValueOf(base: Record<string, unknown>, field: string): Record<string, unknown>[] {
  const without = { ...base };
  delete without[field];
  return [without, ...PALETTE.map((value) => ({ ...base, [field]: value }))];
}

/** Every answer made from `base` by changing one of its fields, or one field of an object nested at `nested`. */
function variations(base: Record<string, unknown>, nested: Record<string, Record<string, unknown>> = {}): unknown[] {
  const found: unknown[] = [base, { ...base, unknown: 1 }, ...PALETTE, [base], 'text'];
  for (const field of new Set([...Object.keys(base), ...Object.keys(nested)])) {
    found.push(...eachValueOf(base, field));
  }
  for (const [field, inner] of Object.entries(nested)) {
    for (const key of Object.keys(inner)) {
      for (const changed of eachValueOf(inner, key)) found.push({ ...base, [field]: changed });
    }
    found.push({ ...base, [field]: { ...inner, unknown: 1 } });
  }
  return found;
}

function assertSameReading(
  handWritten: (body: unknown) => unknown,
  contract: { safeParse(input: unknown): { success: boolean; data?: unknown } },
  inputs: unknown[],
): { accepted: number; refused: number } {
  let accepted = 0;
  for (const input of inputs) {
    const before = handWrittenReading(handWritten, input);
    const after = contractReading(contract, input);
    assert.equal(after.accepted, before.accepted, `accepted ${label(input)}`);
    if (before.accepted && after.accepted) {
      assert.deepEqual(after.value, before.value, `read ${label(input)}`);
      accepted += 1;
    }
  }
  return { accepted, refused: inputs.length - accepted };
}

describe('the contract reads the answers the uploader reads as its hand-written readers did', () => {
  it('an ingest lookup answer', () => {
    const inputs = [...variations(DRAFT), ...variations({ ...DRAFT, mediaType: 'audio' })];
    const counts = assertSameReading(asDraft, ingestLookupAnswerSchema, inputs);
    assert.ok(counts.accepted > 10 && counts.refused > 100, JSON.stringify(counts));
  });

  it('a rung report answer', () => {
    const inputs: unknown[] = [];
    for (const ladder of [MERGED.ladder, { finished: true, flippedToFinished: true, duration: 12 }]) {
      const base = { ...MERGED, ladder };
      inputs.push(...variations(base, { stream: base.stream, ladder: base.ladder, feed: base.feed }));
      for (const rung of [RUNG, FINISHED_RUNG]) {
        for (const field of new Set([...Object.keys(rung), 'index', 'duration'])) {
          for (const changed of eachValueOf(rung, field)) {
            inputs.push({ ...base, renditions: [changed] }, { ...base, renditions: [RUNG, changed] });
          }
        }
        inputs.push({ ...base, renditions: [{ ...rung, codecs: 'avc1' }] });
      }
      for (const index of PALETTE) {
        for (const duration of PALETTE) inputs.push({ ...base, renditions: [{ ...RUNG, index, duration }] });
      }
      for (const renditions of PALETTE) inputs.push({ ...base, renditions: [renditions] });
    }
    const counts = assertSameReading(asRenditionReport, renditionReportAnswerSchema, inputs);
    assert.ok(counts.accepted > 100 && counts.refused > 100, JSON.stringify(counts));
  });

  it("the feed owner off the admin's public config", () => {
    const inputs = variations({ feed: { owner: '0xabc', topic: 't' } }, { feed: { owner: '0xabc', topic: 't' } });
    let owners = 0;
    for (const input of inputs) {
      assert.equal(feedOwnerOf(input), feedOwnerOfConfig(input), label(input));
      if (feedOwnerOfConfig(input) !== null) owners += 1;
    }
    assert.ok(owners > 2 && inputs.length - owners > 50, JSON.stringify({ owners, inputs: inputs.length }));
  });

  it('two feed owners compared', () => {
    const owners = [
      '',
      ' ',
      'abcd',
      'ABCD',
      '0xabcd',
      '0XABCD',
      ' 0xabcd ',
      '0x0xabcd',
      'x0abcd',
      'abce',
      '0x',
      '\t0xAbCd\n',
    ];
    let same = 0;
    for (const left of owners) {
      for (const right of owners) {
        assert.equal(sameFeedOwner(left, right), handWrittenSameFeedOwner(left, right), label([left, right]));
        if (sameFeedOwner(left, right)) same += 1;
      }
    }
    assert.ok(same > owners.length, String(same));
  });

  it('the ingest lookup path', () => {
    const ids = ['video/demo', 'audio/x', 'a b/c?d#e', '/video//x/', '', '..', 'video/../x', 'ü/%20', 'a\\b', 'video'];
    for (const id of ids) assert.equal(ingestLookupPath(id), lookupPath(id), id);
  });
});
