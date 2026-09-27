import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ADMIN_API_TOKEN_KEY, ADMIN_API_TOKEN_MIN_LENGTH, ADMIN_API_URL_KEY } from './adminLink.js';

describe('the admin link settings', () => {
  it('names the address and the token the uploader reads', () => {
    assert.equal(ADMIN_API_URL_KEY, 'ADMIN_API_URL');
    assert.equal(ADMIN_API_TOKEN_KEY, 'ADMIN_API_TOKEN');
  });

  it('asks for a token of at least 32 characters', () => {
    assert.equal(ADMIN_API_TOKEN_MIN_LENGTH, 32);
  });
});
