/**
 * What an archive stamp holds, against bee-js. Unit test: `pnpm test`.
 *
 * `packages/contracts` keeps the capacity table that sizes an archive stamp, and has no bee-js of its own. This
 * backend has, so the comparison lives here: every depth of the table against bee-js's `getStampEffectiveBytes` for a
 * plain upload, with no encryption and no erasure coding. A bee-js that moves a row fails this test, and the table is
 * then changed with it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Utils } from '@ethersphere/bee-js';
import {
  ARCHIVE_EFFECTIVE_BYTES_BY_DEPTH,
  ARCHIVE_MAX_DEPTH,
  ARCHIVE_MIN_DEPTH,
  archiveEffectiveBytes,
} from '@streaming-monorepo/contracts';

/** bee-js reads its table from sizes written in text, which leaves some rows a byte off a round number. */
const ROUNDING_BYTES = 1;

describe('the archive capacity table', () => {
  it('holds at every depth what bee-js says an unencrypted batch without erasure coding holds', () => {
    for (let depth = ARCHIVE_MIN_DEPTH; depth <= ARCHIVE_MAX_DEPTH; depth++) {
      const beeJs = Utils.getStampEffectiveBytes(depth, false, 0);
      const ours = archiveEffectiveBytes(depth);
      assert.ok(Math.abs(beeJs - ours) <= ROUNDING_BYTES, `depth ${depth}: bee-js ${beeJs}, the table ${ours}`);
    }
  });

  it('names every depth from the shallowest a batch can have, under which bee-js holds nothing either', () => {
    assert.equal(Object.keys(ARCHIVE_EFFECTIVE_BYTES_BY_DEPTH).length, ARCHIVE_MAX_DEPTH - ARCHIVE_MIN_DEPTH + 1);
    assert.equal(Utils.getStampEffectiveBytes(ARCHIVE_MIN_DEPTH - 1, false, 0), 0);
    assert.equal(archiveEffectiveBytes(ARCHIVE_MIN_DEPTH - 1), 0);
  });
});
