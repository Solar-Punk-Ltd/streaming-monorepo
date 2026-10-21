/**
 * Which address a request is held responsible for.
 *
 * Unit test, no server. The lockout counts failures against this address, so
 * reading the hop a client wrote itself would let anyone reset their own count.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Request } from 'express';

import { clientIpOf, limiterAddress } from './clientIp.js';

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
    assert.equal(clientIpOf(requestFrom('203.0.113.4, 198.51.100.8, 198.51.100.9')), '198.51.100.9');
  });

  it('reads a header sent more than once as one list', () => {
    assert.equal(clientIpOf(requestFrom(['203.0.113.4', '198.51.100.9'])), '198.51.100.9');
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

describe('the address the limiter keys on', () => {
  it('keeps an IPv4 address as it is', () => {
    assert.equal(limiterAddress('192.0.2.10'), '192.0.2.10');
  });

  it('reads an IPv4-mapped IPv6 address as the IPv4 address, in either form', () => {
    assert.equal(limiterAddress('::ffff:192.0.2.10'), '192.0.2.10');
    assert.equal(limiterAddress('::FFFF:c000:20a'), '192.0.2.10');
  });

  it('keys an IPv6 address by its /64, with a zone id dropped', () => {
    assert.equal(limiterAddress('2001:db8:0:1::5'), '2001:db8:0:1::/64');
    assert.equal(limiterAddress('2001:0DB8:0000:0001:1234:5678:9abc:def0'), '2001:db8:0:1::/64');
    assert.equal(limiterAddress('fe80::1%eth0'), 'fe80:0:0:0::/64');
    assert.equal(limiterAddress('::1'), '0:0:0:0::/64');
    assert.notEqual(limiterAddress('2001:db8:0:1::5'), limiterAddress('2001:db8:0:2::5'));
  });

  it('leaves anything that does not parse as it was sent', () => {
    for (const raw of ['unknown', '', '999.1.1.1', '1.2.3', 'not:an:address:at:all:x:y:z', '1::2::3', 'abc']) {
      assert.equal(limiterAddress(raw), raw, JSON.stringify(raw));
    }
  });
});
