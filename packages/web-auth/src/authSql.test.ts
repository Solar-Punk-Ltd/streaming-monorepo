import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { USER_REMOVAL_LOCK_KEY } from './authSql.js';

describe('the user removal lock', () => {
  it('is the ASCII of "user", the key both backends have always taken', () => {
    assert.equal(USER_REMOVAL_LOCK_KEY, 0x75736572);
    assert.equal(Buffer.from(USER_REMOVAL_LOCK_KEY.toString(16), 'hex').toString('ascii'), 'user');
  });
});
