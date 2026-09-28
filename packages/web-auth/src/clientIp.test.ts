/**
 * Which address a request is held responsible for.
 *
 * Unit test, no server. The lockout counts failures against this address, so
 * reading the hop a client wrote itself would let anyone reset their own count.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Request } from 'express';

import { clientIpOf } from './clientIp.js';

function requestFrom(forwardedFor: string | string[] | undefined, remoteAddress?: string): Request {
  return {
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    socket: { remoteAddress },
  } as unknown as Request;
}

describe('clientIpOf', () => {
  it('takes the last hop of X-Forwarded-For, the one the proxy appended', () => {
    assert.equal(clientIpOf(requestFrom('203.0.113.7, 10.0.0.2', '10.0.0.1')), '10.0.0.2');
  });

  it('ignores the hops a client wrote itself', () => {
    assert.equal(clientIpOf(requestFrom('1.2.3.4, 5.6.7.8, 198.51.100.9')), '198.51.100.9');
  });

  it('reads a header sent more than once as one list', () => {
    assert.equal(clientIpOf(requestFrom(['1.2.3.4', '198.51.100.9'])), '198.51.100.9');
  });

  it('skips empty hops and surrounding space', () => {
    assert.equal(clientIpOf(requestFrom(' 198.51.100.9 , , ')), '198.51.100.9');
  });

  it('falls back to the socket address with no usable header', () => {
    for (const header of [undefined, '', ' , ']) {
      assert.equal(clientIpOf(requestFrom(header, '10.0.0.1')), '10.0.0.1', JSON.stringify(header));
    }
  });

  it('answers unknown when there is no address at all', () => {
    assert.equal(clientIpOf(requestFrom(undefined)), 'unknown');
  });
});
