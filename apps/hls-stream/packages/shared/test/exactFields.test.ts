import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasExactlyFields } from '../src/exactFields.js';

describe('hasExactlyFields', () => {
  it('accepts the named fields whatever order the list names them in', () => {
    const marker = { v: 2, period: 1, writtenAt: 10_000, rungs: {}, segmentMs: 2_000 };
    assert.equal(hasExactlyFields(marker, ['v', 'period', 'writtenAt', 'rungs', 'segmentMs']), true);
    assert.equal(hasExactlyFields(marker, ['period', 'rungs', 'segmentMs', 'v', 'writtenAt']), true);
  });

  it('accepts the fields whatever order the object holds them in', () => {
    assert.equal(hasExactlyFields({ b: 1, a: 2 }, ['a', 'b']), true);
  });

  it('rejects a missing field', () => {
    assert.equal(hasExactlyFields({ a: 1 }, ['a', 'b']), false);
  });

  it('rejects an extra field', () => {
    assert.equal(hasExactlyFields({ a: 1, b: 2, c: 3 }, ['a', 'b']), false);
  });

  it('rejects a field in place of another', () => {
    assert.equal(hasExactlyFields({ a: 1, c: 2 }, ['a', 'b']), false);
  });
});
