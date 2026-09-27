/**
 * The contract reads every admin answer Test connection reads, and reads it to
 * the same value, as the probe's hand-written readers in
 * support/handWrittenAdminLinkReaders.ts did.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * Measured, not argued: the public config's owner, the config's feed and the
 * body itself are each given every value in a palette of the shapes a JSON body
 * can carry and a few it cannot, or left out, and both readings are compared.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ADMIN_ERROR_STREAM_NOT_FOUND,
  ADMIN_ERROR_UNAUTHENTICATED,
  feedOwnerOf,
  ingestLookupPath,
  MEDIA_TYPE_VIDEO,
  sameFeedOwner,
} from '@streaming-monorepo/contracts';

import {
  feedOwnerOf as handWrittenFeedOwnerOf,
  sameFeedOwner as handWrittenSameFeedOwner,
  STREAM_NOT_FOUND,
  UNAUTHENTICATED,
  UNUSED_STREAM_PATH,
} from './support/handWrittenAdminLinkReaders.js';

const PALETTE: unknown[] = [
  undefined,
  null,
  '',
  ' ',
  '0',
  '3',
  'abc',
  '0xabc',
  'x',
  [],
  [3],
  ['0xabc'],
  {},
  { owner: '0xabc' },
  { value: 3 },
  true,
  false,
  0,
  -0,
  1,
  3.5,
  -1,
  1e21,
  Infinity,
  -Infinity,
  NaN,
];

function label(input: unknown): string {
  return JSON.stringify(input, (_key, value: unknown) =>
    value === undefined || (typeof value === 'number' && !Number.isFinite(value)) ? `<${String(value)}>` : value,
  );
}

/** `base` with `field` given every value in the palette, and with it left out. */
function eachValueOf(base: Record<string, unknown>, field: string): Record<string, unknown>[] {
  const without = { ...base };
  delete without[field];
  return [without, ...PALETTE.map((value) => ({ ...base, [field]: value }))];
}

describe('the contract reads the answers Test connection reads as the probe did', () => {
  it("the feed owner off the admin's public config", () => {
    const feed = { owner: '0xabc', topic: 't', topicHex: 'ab' };
    const bodies: unknown[] = [
      ...PALETTE,
      { feed },
      { feed, unknown: 1 },
      [{ feed }],
      ...eachValueOf({ feed }, 'feed'),
    ];
    for (const key of Object.keys(feed)) {
      for (const changed of eachValueOf(feed, key)) bodies.push({ feed: changed });
    }
    let owners = 0;
    for (const body of bodies) {
      const before = handWrittenFeedOwnerOf({ kind: 'answered', status: 200, body });
      assert.equal(feedOwnerOf(body), before, label(body));
      if (before !== null) owners += 1;
    }
    assert.ok(owners > 2 && bodies.length - owners > 50, JSON.stringify({ owners, bodies: bodies.length }));
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

  it('the error codes and the lookup of a stream nobody declared', () => {
    assert.equal(ADMIN_ERROR_STREAM_NOT_FOUND, STREAM_NOT_FOUND);
    assert.equal(ADMIN_ERROR_UNAUTHENTICATED, UNAUTHENTICATED);
    assert.equal(ingestLookupPath(`${MEDIA_TYPE_VIDEO}/00000000-0000-0000-0000-000000000000`), UNUSED_STREAM_PATH);
  });
});
