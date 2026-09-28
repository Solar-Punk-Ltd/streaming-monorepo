/**
 * The manager's session cookie on the wire: its name, and how its value is read.
 *
 * Unit test, no server. How a Cookie header is parsed and which attributes the
 * cookie carries are pinned in the shared web-auth package. This pins what is
 * the manager's own, because a browser signed in to it holds a cookie by this
 * name, and a rename signs every one of them out.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Request, Response } from 'express';

import { clearSessionCookie, readSessionToken, setSessionCookie } from '../../src/api/sessionCookie.js';

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

describe('the manager session cookie', () => {
  it('is written and cleared as sim_session', () => {
    const { res, names } = recordingResponse();

    setSessionCookie(requestWith(), res, TOKEN);
    clearSessionCookie(requestWith(), res);

    assert.deepEqual(names, ['sim_session', 'sim_session']);
  });

  it('is read from sim_session and from no other name', () => {
    assert.equal(readSessionToken(requestWith(`theme=dark; sim_session=${TOKEN}`)), TOKEN);
    assert.equal(readSessionToken(requestWith(`web2_admin_session=${TOKEN}`)), null);
    assert.equal(readSessionToken(requestWith()), null);
  });

  it('reads an empty value as no token, as the admin does', () => {
    assert.equal(readSessionToken(requestWith('sim_session=')), null);
  });
});
