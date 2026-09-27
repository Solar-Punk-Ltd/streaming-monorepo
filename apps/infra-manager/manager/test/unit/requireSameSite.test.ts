/**
 * The manager's cross-site gate on the wire: the header it reads and the one
 * value it lets through.
 *
 * Unit test, no server. Every combination of the three headers the gate reads
 * is pinned in the shared web-auth package. This pins what is the manager's
 * own, because the console sends exactly this header and value on every write,
 * and a gate that expected anything else would refuse all of them.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NextFunction, Request, Response } from 'express';

import { crossSiteReason, requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { CrossSiteRequestError } from '../../src/domain/errors/index.js';

const HOST = 'manager.example';

function passedOn(headers: Record<string, string>): unknown {
  const req = { method: 'POST', headers: { host: HOST, origin: `https://${HOST}`, ...headers } } as unknown as Request;
  let passed: unknown = 'next was never called';
  requireSameSite(
    req,
    {} as Response,
    ((error?: unknown) => {
      passed = error;
    }) as NextFunction,
  );
  return passed;
}

describe('the manager cross-site gate', () => {
  it('lets a write carrying x-requested-with: streaming-infra-manager through', () => {
    assert.equal(passedOn({ 'x-requested-with': 'streaming-infra-manager' }), undefined);
  });

  it('refuses any other value, the admin console one included', () => {
    for (const value of ['web2-admin', 'XMLHttpRequest', 'Streaming-Infra-Manager']) {
      assert.ok(passedOn({ 'x-requested-with': value }) instanceof CrossSiteRequestError, value);
    }
  });

  it('names the header a refused write is missing', () => {
    assert.equal(
      crossSiteReason({
        method: 'POST',
        host: HOST,
        origin: undefined,
        secFetchSite: undefined,
        requestedWith: undefined,
      }),
      'a write needs the x-requested-with header',
    );
  });
});
