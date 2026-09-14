/**
 * The internal API's door. Unit test — the middleware only, with stand-ins for
 * Express's request and response.
 *
 * Behind it sit the two routes that can flip a stream live and rewrite its
 * catalogue entry, and unlike the console's routes there is no second factor:
 * whoever presents the token is the uploader. So what is pinned here is that
 * nothing but an exact `Bearer <token>` gets through — no prefix, no near
 * miss, no empty header, and no session cookie.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Request, Response } from 'express';

import { createRequireInternalToken } from '../../src/api/middleware/requireInternalToken.js';
import { UnauthenticatedError } from '../../src/domain/errors/index.js';

const TOKEN = 'b6f5672800112233445566778899aabbccddeeff00112233';

/** Just enough Request: the middleware only ever reads one header. */
function request(headers: Record<string, string>): Request {
  return {
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

function run(authorization: string | undefined): unknown {
  const middleware = createRequireInternalToken(TOKEN);
  let outcome: unknown = 'not called';
  middleware(
    request(authorization === undefined ? {} : { authorization }),
    {} as Response,
    ((err?: unknown) => {
      outcome = err ?? null;
    }) as never,
  );
  return outcome;
}

const passed = (authorization: string | undefined) =>
  run(authorization) === null;

describe('requireInternalToken', () => {
  it('lets the configured token through', () => {
    assert.equal(passed(`Bearer ${TOKEN}`), true);
  });

  it('tolerates whitespace around the token', () => {
    // Shells and .env files add trailing spaces; the value is still the token.
    assert.equal(passed(`Bearer ${TOKEN}  `), true);
  });

  it('refuses a missing, empty or non-bearer header', () => {
    for (const header of [undefined, '', 'Bearer', 'Bearer ', TOKEN, `Basic ${TOKEN}`]) {
      assert.ok(
        run(header) instanceof UnauthenticatedError,
        `accepted: ${String(header)}`,
      );
    }
  });

  it('refuses a token that is close but not equal', () => {
    for (const wrong of [
      TOKEN.slice(0, -1),
      `${TOKEN}0`,
      TOKEN.toUpperCase(),
      TOKEN.replace('b6', 'b7'),
    ]) {
      assert.ok(
        run(`Bearer ${wrong}`) instanceof UnauthenticatedError,
        `accepted: ${wrong}`,
      );
    }
  });
});
