/**
 * The admin's session cookie on the wire: its name, and how its value is read.
 *
 * Unit test, no server. How a Cookie header is parsed and which attributes the
 * cookie carries are pinned in the shared web-auth package. This pins what is
 * the admin's own, because a browser signed in to it holds a cookie by this
 * name, and a rename signs every one of them out.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Request, Response } from 'express';

import { clearSessionCookie, readSessionToken, setSessionCookie } from '../../src/api/cookies.js';

const NAME = 'web2_admin_session';
const TOKEN = 'a'.repeat(43);

function requestWith(cookie?: string): Request {
  return { headers: cookie === undefined ? {} : { cookie }, secure: false } as unknown as Request;
}

function recordingResponse() {
  const names: string[] = [];
  const res = {
    cookie(name: string) {
      names.push(name);
      return res;
    },
    clearCookie(name: string) {
      names.push(name);
      return res;
    },
  };
  return { res: res as unknown as Response, names };
}

describe('the admin session cookie', () => {
  it('is written and cleared as web2_admin_session', () => {
    const { res, names } = recordingResponse();

    setSessionCookie(requestWith(), res, TOKEN);
    clearSessionCookie(requestWith(), res);

    assert.deepEqual(names, [NAME, NAME]);
  });

  it('finds the session cookie among others', () => {
    assert.equal(readSessionToken(requestWith(`theme=dark; ${NAME}=${TOKEN}; tz=UTC`)), TOKEN);
  });

  it('is null when there is no cookie header, and when ours is absent', () => {
    assert.equal(readSessionToken(requestWith()), null);
    assert.equal(readSessionToken(requestWith('theme=dark')), null);
    assert.equal(readSessionToken(requestWith(`sim_session=${TOKEN}`)), null);
  });

  it('is null for an empty value', () => {
    assert.equal(readSessionToken(requestWith(`${NAME}=`)), null);
  });

  it('does not match a cookie whose name merely ends with ours', () => {
    assert.equal(readSessionToken(requestWith(`not_${NAME}=${TOKEN}`)), null);
  });

  it('never throws on a value that is not valid percent-encoding', () => {
    for (const value of ['%', '%zz', `${TOKEN}%`, '100%25%']) {
      const read = readSessionToken(requestWith(`${NAME}=${value}`));
      assert.equal(typeof read, 'string', value);
    }
  });
});
