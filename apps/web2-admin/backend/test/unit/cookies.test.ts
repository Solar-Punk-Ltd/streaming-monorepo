/**
 * Reading the Cookie header, which is where the session token arrives, and the
 * attributes the session cookie is written with.
 *
 * Unit test, no server. Written by hand rather than with a library, so the
 * edges a library would have handled are pinned here: no separating space, an
 * `=` inside the value, quoting, junk pairs, a name that would be a booby trap
 * as an object key, and above all a value that is not valid percent-encoding,
 * which used to throw URIError and reach the error handler as a 500 on *every*
 * request — including the logout that would clear it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Request, Response } from 'express';

import { clearSessionCookie, readSessionToken, setSessionCookie } from '../../src/api/cookies.js';
import { parseCookies } from '../../src/utils/cookies.js';

const NAME = 'web2_admin_session';
const TOKEN = 'a'.repeat(43);

function requestWith(cookie?: string, headers: Record<string, string> = {}, secure = false): Request {
  return {
    headers: { ...(cookie === undefined ? {} : { cookie }), ...headers },
    secure,
  } as unknown as Request;
}

/** Records what res.cookie / res.clearCookie were asked for. */
function recordingResponse() {
  const calls: { name: string; value?: string; options: unknown }[] = [];
  const res = {
    cookie(name: string, value: string, options: unknown) {
      calls.push({ name, value, options });
      return res;
    },
    clearCookie(name: string, options: unknown) {
      calls.push({ name, options });
      return res;
    },
  };
  return { res: res as unknown as Response, calls };
}

describe('parseCookies', () => {
  it('reads a single pair', () => {
    assert.equal(parseCookies(`${NAME}=abc`).get(NAME), 'abc');
  });

  it('reads pairs with or without a space after the separator', () => {
    for (const header of ['a=1; b=2', 'a=1;b=2', 'a=1 ;  b=2']) {
      const cookies = parseCookies(header);
      assert.equal(cookies.get('a'), '1', header);
      assert.equal(cookies.get('b'), '2', header);
    }
  });

  it('keeps everything after the first = as the value', () => {
    // base64 padding and base64url both put = and - inside a value.
    assert.equal(parseCookies('t=YWJj==').get('t'), 'YWJj==');
    assert.equal(parseCookies('t=a=b=c').get('t'), 'a=b=c');
  });

  it('unwraps a quoted value', () => {
    assert.equal(parseCookies('t="abc"').get('t'), 'abc');
    assert.equal(parseCookies('t="ab"c"').get('t'), 'ab"c');
  });

  it('decodes percent-encoding, and leaves a broken one alone', () => {
    assert.equal(parseCookies('t=a%20b').get('t'), 'a b');
    assert.equal(parseCookies('t=100%').get('t'), '100%');
    assert.equal(parseCookies('t=%E0%A4%A').get('t'), '%E0%A4%A');
  });

  it('is empty for nothing, and skips pairs that are not pairs', () => {
    for (const header of [undefined, '', '   ', ';;', 'novalue', '=orphan']) {
      assert.equal(parseCookies(header).size, 0, `should read nothing from ${JSON.stringify(header)}`);
    }
  });

  it('keeps the good pairs when one is junk', () => {
    const cookies = parseCookies(`broken; ${NAME}=abc; =x; b=2`);

    assert.equal(cookies.size, 2);
    assert.equal(cookies.get(NAME), 'abc');
    assert.equal(cookies.get('b'), '2');
  });

  it('holds a name that would be a booby trap as an object key', () => {
    // A Map, not an object, so `__proto__` is a key like any other and cannot
    // reach anything's prototype.
    const cookies = parseCookies(`__proto__=polluted; ${NAME}=abc`);

    assert.equal(cookies.get('__proto__'), 'polluted');
    assert.equal(cookies.get(NAME), 'abc');
  });

  it('lets the last value of a repeated name win', () => {
    assert.equal(parseCookies('t=first; t=second').get('t'), 'second');
  });
});

describe('readSessionToken', () => {
  it('finds the session cookie among others', () => {
    assert.equal(readSessionToken(requestWith(`theme=dark; ${NAME}=${TOKEN}; tz=UTC`)), TOKEN);
  });

  it('is null when there is no cookie header, and when ours is absent', () => {
    assert.equal(readSessionToken(requestWith()), null);
    assert.equal(readSessionToken(requestWith('theme=dark')), null);
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

describe('the session cookie', () => {
  it('is httpOnly, lax and rooted at /, with no expiry of its own', () => {
    const { res, calls } = recordingResponse();
    setSessionCookie(requestWith(), res, TOKEN);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, NAME);
    assert.equal(calls[0]!.value, TOKEN);
    // No maxAge and no expires: the sessions row is the only clock, and a
    // cookie with a deadline of its own would be a second one to keep in step.
    assert.deepEqual(calls[0]!.options, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: false,
    });
  });

  it('is Secure only when the browser really was on HTTPS', () => {
    const secureOf = (req: Request): boolean => {
      const { res, calls } = recordingResponse();
      setSessionCookie(req, res, TOKEN);
      return (calls[0]!.options as { secure: boolean }).secure;
    };

    // Marking it Secure on a plain-HTTP origin makes the browser drop the
    // cookie it was just given, and the sign-in loops back to the form.
    assert.equal(secureOf(requestWith()), false);
    assert.equal(secureOf(requestWith(undefined, { 'x-forwarded-proto': 'http' })), false);
    assert.equal(secureOf(requestWith(undefined, { 'x-forwarded-proto': 'https' })), true);
    // Only the first hop is the browser's; anything after it is another proxy.
    assert.equal(secureOf(requestWith(undefined, { 'x-forwarded-proto': 'https, http' })), true);
    assert.equal(secureOf(requestWith(undefined, { 'x-forwarded-proto': 'http, https' })), false);
    assert.equal(secureOf(requestWith(undefined, {}, true)), true);
  });

  it('is cleared with the attributes it was set with', () => {
    const { res, calls } = recordingResponse();
    const req = requestWith(undefined, { 'x-forwarded-proto': 'https' });

    setSessionCookie(req, res, TOKEN);
    clearSessionCookie(req, res);

    // Or the browser keeps the original cookie alongside the expired one.
    assert.deepEqual(calls[1]!.options, calls[0]!.options);
  });
});
