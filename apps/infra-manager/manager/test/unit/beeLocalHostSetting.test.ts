/**
 * BEE_LOCAL_HOST: the host the manager reaches a locally published port on.
 *
 * Unit test, no database. `pnpm test` in manager/.
 *
 * A malformed value stops the manager rather than being carried, for the
 * reason CHEQUEBOOK_FLOOR_BZZ does. The value goes into the address of every
 * local uploader health read, every local Bee API call and every local pool
 * string, so a filesystem path left in it read as "uploader unreachable" on
 * every local stage for a day, with nothing above a debug line saying why.
 * An IPv6 address is refused too, for now, because the manager cannot make a
 * working address out of one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { beeLocalHost, config } from '../../src/utils/config.js';

describe('the host a locally published port is reached on', () => {
  it('is none when the operator set nothing, so the default applies', () => {
    for (const empty of [undefined, '', '   ']) {
      assert.equal(beeLocalHost(empty), null);
    }
  });

  it('takes a host name, trimmed', () => {
    assert.equal(beeLocalHost('  bee-gateway.internal  '), 'bee-gateway.internal');
    assert.equal(beeLocalHost('host.docker.internal'), 'host.docker.internal');
    assert.equal(beeLocalHost('localhost'), 'localhost');
  });

  it('takes an IPv4 address', () => {
    assert.equal(beeLocalHost('172.17.0.1'), '172.17.0.1');
    assert.equal(beeLocalHost('127.0.0.1'), '127.0.0.1');
  });

  it('stops the manager on an IPv6 address for now, and says why', () => {
    // The manager writes the host into http://<host>:<port> without brackets, which no IPv6 address survives.
    for (const address of ['fd00::1', '::1']) {
      assert.throws(
        () => beeLocalHost(address),
        (err: Error) =>
          err.message.startsWith('BEE_LOCAL_HOST does not take an IPv6 address yet') &&
          err.message.includes('without brackets') &&
          err.message.endsWith(`got: ${address}`),
        address,
      );
    }
  });

  it('stops the manager on a filesystem path, and names the setting and the shape', () => {
    assert.throws(
      () => beeLocalHost('/opt/streaming/bee'),
      (err: Error) =>
        /BEE_LOCAL_HOST/.test(err.message) &&
        /host name/.test(err.message) &&
        err.message.includes('/opt/streaming/bee'),
    );
  });

  it('stops the manager on a URL with a scheme', () => {
    assert.throws(() => beeLocalHost('http://172.17.0.1'), /BEE_LOCAL_HOST/);
  });

  it('stops the manager on a host with a port', () => {
    assert.throws(() => beeLocalHost('172.17.0.1:1633'), /BEE_LOCAL_HOST/);
    assert.throws(() => beeLocalHost('localhost:1633'), /BEE_LOCAL_HOST/);
    assert.throws(() => beeLocalHost('[fd00::1]:1633'), /BEE_LOCAL_HOST/);
  });

  it('stops the manager on a host with a path or a space inside', () => {
    assert.throws(() => beeLocalHost('172.17.0.1/health'), /BEE_LOCAL_HOST/);
    assert.throws(() => beeLocalHost('bee gateway'), /BEE_LOCAL_HOST/);
  });

  it('stops the manager on what only looks like an address or a name', () => {
    // Every label of a host name may be digits but the last, so these are broken addresses rather than names.
    assert.throws(() => beeLocalHost('172.17.0.256'), /BEE_LOCAL_HOST/);
    assert.throws(() => beeLocalHost('1633'), /BEE_LOCAL_HOST/);
    for (const name of [
      '-bee.internal',
      'bee-.internal',
      'bee..internal',
      'bee.internal.',
      'bee_gateway',
      'a'.repeat(64),
    ]) {
      assert.throws(() => beeLocalHost(name), /BEE_LOCAL_HOST/, name);
    }
  });

  it('is what the manager’s config carries, read from the environment once', () => {
    assert.equal(config.beeLocalHost, beeLocalHost(process.env.BEE_LOCAL_HOST));
  });
});
