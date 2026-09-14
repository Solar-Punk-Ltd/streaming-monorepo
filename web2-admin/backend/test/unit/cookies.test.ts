/**
 * Session cookie parsing. Unit test — a header string in, a token out.
 *
 * Hand-rolled, so the edges are ours to get right: a cookie among others, an
 * empty value, and above all a value that is not valid percent-encoding, which
 * used to throw URIError out of readSessionToken and reach the error handler as
 * a 500 on *every* request — including the logout that would clear it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Request } from 'express';

import { readSessionToken } from '../../src/api/cookies.js';

/** readSessionToken reads nothing but `req.headers.cookie`. */
function requestWith(cookie?: string): Request {
  return { headers: cookie === undefined ? {} : { cookie } } as Request;
}

const TOKEN = 'a'.repeat(64);

describe('readSessionToken', () => {
  it('finds the session cookie among others', () => {
    assert.equal(
      readSessionToken(requestWith(`theme=dark; web2_admin_session=${TOKEN}; tz=UTC`)),
      TOKEN,
    );
    assert.equal(readSessionToken(requestWith(`web2_admin_session=${TOKEN}`)), TOKEN);
  });

  it('is null when there is no cookie header, and when ours is absent', () => {
    assert.equal(readSessionToken(requestWith()), null);
    assert.equal(readSessionToken(requestWith('theme=dark')), null);
  });

  it('is null for an empty value', () => {
    assert.equal(readSessionToken(requestWith('web2_admin_session=')), null);
  });

  it('does not match a cookie whose name merely ends with ours', () => {
    assert.equal(
      readSessionToken(requestWith(`not_web2_admin_session=${TOKEN}`)),
      null,
    );
  });

  it('treats an undecodable value as no session instead of throwing', () => {
    for (const value of ['%', '%zz', `${TOKEN}%`, '100%25%']) {
      assert.equal(
        readSessionToken(requestWith(`web2_admin_session=${value}`)),
        null,
        value,
      );
    }
  });

  it('decodes a value that is percent-encoded', () => {
    assert.equal(readSessionToken(requestWith('web2_admin_session=a%20b')), 'a b');
  });
});
