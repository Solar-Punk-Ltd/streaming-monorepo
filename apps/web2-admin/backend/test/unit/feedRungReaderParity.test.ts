import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { adminFeedRungSchema } from '@streaming-monorepo/contracts';

import { isRendition } from './support/feedRungReaderBeforeContract.js';

/**
 * The contract's schema accepts exactly the rungs the admin's own reader accepted when it read a ladder back off the
 * catalog: every field of a valid rung swapped for every value in a palette of what a JSON feed can carry.
 */

const PALETTE: unknown[] = [
  undefined,
  null,
  '',
  '3',
  'abc',
  [],
  [3],
  {},
  true,
  false,
  0,
  -0,
  1,
  3.5,
  -1,
  Infinity,
  -Infinity,
  Number.NaN,
];

const RUNG = {
  name: '720p',
  width: 1280,
  height: 720,
  topic: 'rung-topic',
  bandwidth: 2_800_000,
  avgBandwidth: 2_500_000,
};

describe("the contract reads a rung off the catalog as the admin's own reader did", () => {
  it('a rung', () => {
    const inputs: unknown[] = [RUNG, { ...RUNG, unknown: 1 }, null, [], 'text', 3, [RUNG]];
    for (const field of [...Object.keys(RUNG), 'index', 'duration']) {
      for (const value of PALETTE) inputs.push({ ...RUNG, [field]: value });
    }
    let accepted = 0;
    for (const input of inputs) {
      const before = isRendition(input);
      assert.equal(adminFeedRungSchema.safeParse(input).success, before, String(JSON.stringify(input)));
      if (before) accepted += 1;
    }
    assert.ok(accepted > 5 && accepted < inputs.length - 5, `${accepted} of ${inputs.length}`);
  });
});
