import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ingestLookupParamsSchema,
  renditionReportSchema as renditionReportContract,
  streamStateReportSchema,
} from '@streaming-monorepo/contracts';
import type { AnySchema } from 'yup';

import { ingestLookupParamSchema, renditionReportSchema, streamStateSchema } from './support/yupInternalSchemas.js';

/**
 * The contract's schemas read every request the internal routes' yup schemas read, and read it to the same values.
 *
 * Measured, not argued: every field of a valid request is swapped for every value in a palette of the shapes a JSON
 * body or a route parameter can carry, and both readings are compared, as the routes run them, yup with
 * `stripUnknown` and every error collected.
 */

const TOPIC = '1867808f-7b1c-4e46-b437-f7423b466b39';

const PALETTE: unknown[] = [
  undefined,
  null,
  '',
  ' ',
  '0',
  '3',
  ' 3 ',
  '3.5',
  '-1',
  '1e400',
  '0x10',
  'abc',
  [],
  [3],
  [1, 2],
  ['3'],
  {},
  { value: 3 },
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
  'live',
  'vod',
  'LIVE',
  'scheduled',
  'video',
  'audio',
  'VIDEO',
  TOPIC,
  TOPIC.toUpperCase(),
  `${TOPIC} `,
  '720p',
  '720_p',
  '1.5-p',
  'a'.repeat(32),
  'a'.repeat(33),
  720,
];

type Reading = { accepted: true; value: unknown } | { accepted: false };

async function yupReading(schema: AnySchema, input: unknown): Promise<Reading> {
  try {
    return { accepted: true, value: await schema.validate(input, { abortEarly: false, stripUnknown: true }) };
  } catch {
    return { accepted: false };
  }
}

function zodReading(schema: { safeParse(input: unknown): { success: boolean; data?: unknown } }, input: unknown) {
  const result = schema.safeParse(input);
  return result.success ? ({ accepted: true, value: result.data } as const) : ({ accepted: false } as const);
}

/** A reading's value without keys whose value is undefined, which neither reading tells apart from a missing key. */
function withoutUndefined(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/** Every request made from `base` by giving one field, or each pair of `paired` fields, every value in the palette. */
function variations(base: Record<string, unknown>, paired: string[] = []): unknown[] {
  const found: unknown[] = [base, { ...base, unknown: 1 }, null, [], 'text', 3, [base]];
  for (const field of [...Object.keys(base), ...paired.filter((name) => !(name in base))]) {
    for (const value of PALETTE) found.push({ ...base, [field]: value });
  }
  for (const [first, second] of paired.flatMap((a, i) => paired.slice(i + 1).map((b) => [a, b] as const))) {
    for (const a of PALETTE) for (const b of PALETTE) found.push({ ...base, [first]: a, [second]: b });
  }
  return found;
}

async function assertSameReading(
  yupSchema: AnySchema,
  contract: { safeParse(input: unknown): { success: boolean; data?: unknown } },
  inputs: unknown[],
): Promise<{ accepted: number; refused: number }> {
  let accepted = 0;
  for (const input of inputs) {
    const before = await yupReading(yupSchema, input);
    const after = zodReading(contract, input);
    const label = JSON.stringify(input, (_key, value: unknown) => (value === undefined ? '<undefined>' : value));
    assert.equal(after.accepted, before.accepted, `accepted ${label}`);
    if (before.accepted && after.accepted) {
      assert.deepEqual(withoutUndefined(after.value), withoutUndefined(before.value), `read ${label}`);
      accepted += 1;
    }
  }
  return { accepted, refused: inputs.length - accepted };
}

describe("the contract reads the internal routes' requests as their yup schemas did", () => {
  it('the ingest lookup parameters', async () => {
    const counts = await assertSameReading(
      ingestLookupParamSchema,
      ingestLookupParamsSchema,
      variations({ app: 'video', stream: TOPIC }),
    );
    assert.ok(counts.accepted > 2 && counts.refused > 2, JSON.stringify(counts));
  });

  // A recording is named by its reference since 2026-10-07, which the yup schemas never knew, and an index is
  // refused. So the state and rung reports are compared on every other field, and the recording has tests of its own.
  it('a state report', async () => {
    const inputs = variations({ state: 'live' }, ['state']);
    const counts = await assertSameReading(streamStateSchema, streamStateReportSchema, inputs);
    assert.ok(counts.accepted > 2 && counts.refused > 10, JSON.stringify(counts));
  });

  it('a rung report', async () => {
    const rung = {
      name: '720p',
      width: 1280,
      height: 720,
      topic: TOPIC,
      bandwidth: 2_800_000,
      avgBandwidth: 2_500_000,
    };
    const counts = await assertSameReading(renditionReportSchema, renditionReportContract, variations(rung));
    assert.ok(counts.accepted > 10 && counts.refused > 10, JSON.stringify(counts));
  });
});
