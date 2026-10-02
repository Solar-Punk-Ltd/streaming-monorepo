/**
 * Plain http to the manager's web2 admin link: where the manager takes it, and the setting that lets it go anywhere.
 *
 * Every push to the link carries the registrar token and each stage's SRT passphrase, so the manager saves and sends
 * plain http only to its own host or a Docker network of its container, judged by what the address resolves to.
 *
 * Unit test on fake lookups and fake interfaces, no network. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type PlainHttpJudgeDeps, plainHttpAdminLinkJudge } from '../../src/domain/adminLink/plainHttpAdminLink.js';
import { adminLinkAllowPlainHttp } from '../../src/utils/config.js';

/** What a container on two Docker networks sees: the loopback, one address on each network, and a link-local one. */
const CONTAINER_INTERFACES = [
  { cidr: '127.0.0.1/8', internal: true },
  { cidr: '::1/128', internal: true },
  { cidr: '172.18.0.4/16', internal: false },
  { cidr: '10.0.9.3/24', internal: false },
  { cidr: 'fe80::42:acff:fe12:4/64', internal: false },
];

/** What each name resolves to from the manager. A name left out does not resolve. */
const NAMES: Record<string, string[]> = {
  'host.docker.internal': ['172.17.0.1'],
  'web2-admin-backend': ['172.18.0.7'],
  'admin-on-the-overlay': ['10.0.9.12'],
  'admin.example': ['203.0.113.7'],
  'half-local.example': ['172.18.0.9', '203.0.113.8'],
  'link-local.example': ['fe80::1'],
};

function judgeWith(over: PlainHttpJudgeDeps = {}) {
  const looked: string[] = [];
  const judge = plainHttpAdminLinkJudge({
    allowPlainHttp: false,
    isInContainer: () => true,
    interfaces: () => CONTAINER_INTERFACES,
    lookupAll: async (host) => {
      looked.push(host);
      const addresses = NAMES[host];
      if (!addresses) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
      return addresses;
    },
    ...over,
  });
  return { judge, looked };
}

describe('plain http to the web2 admin link', () => {
  it('is taken to a Docker service name on a network of the manager’s container', async () => {
    const { judge } = judgeWith();
    assert.equal(await judge('http://web2-admin-backend:3000'), 'allowed');
    assert.equal(await judge('http://admin-on-the-overlay:3000/api'), 'allowed');
    assert.equal(await judge('http://172.18.0.7:3000'), 'allowed');
  });

  it('is taken to the host’s bridge address, as host.docker.internal resolves it', async () => {
    const { judge } = judgeWith();
    assert.equal(await judge('http://172.17.0.1:3000'), 'allowed');
  });

  it('is refused to another host, by name or by address', async () => {
    const { judge } = judgeWith();
    assert.equal(await judge('http://admin.example:3000'), 'refused');
    assert.equal(await judge('http://203.0.113.7:3000'), 'refused');
    assert.equal(await judge('http://[2001:db8::1]:3000'), 'refused');
  });

  it('is refused to a name that also resolves to another host, or to a link-local address', async () => {
    const { judge } = judgeWith();
    assert.equal(await judge('http://half-local.example:3000'), 'refused');
    assert.equal(await judge('http://link-local.example:3000'), 'refused');
  });

  it('is unresolved for a name that does not resolve now, as Docker answers for a service that is not running', async () => {
    const { judge } = judgeWith();
    assert.equal(await judge('http://not-resolving:3000'), 'unresolved');
  });

  it('reads no Docker network when the manager runs outside a container: its own interfaces are the host’s', async () => {
    const { judge } = judgeWith({ isInContainer: () => false });
    assert.equal(await judge('http://web2-admin-backend:3000'), 'refused');
    assert.equal(await judge('http://172.17.0.1:3000'), 'allowed', 'the bridge, where host.docker.internal resolves');
  });

  it('asks nothing for https, a loopback host or the host gateway’s own name', async () => {
    const { judge, looked } = judgeWith();
    for (const url of [
      'https://admin.example',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
      'http://host.docker.internal:3000',
    ]) {
      assert.equal(await judge(url), 'allowed', url);
    }
    assert.deepEqual(looked, []);
  });

  it('goes anywhere while ADMIN_LINK_ALLOW_PLAIN_HTTP is on, which says so', async () => {
    const { judge, looked } = judgeWith({ allowPlainHttp: true });
    assert.equal(await judge('http://admin.example:3000'), 'allowed-by-setting');
    assert.equal(await judge('https://admin.example'), 'allowed');
    assert.deepEqual(looked, [], 'nothing to resolve');
  });
});

describe('ADMIN_LINK_ALLOW_PLAIN_HTTP', () => {
  it('is off unless it is true', () => {
    assert.equal(adminLinkAllowPlainHttp(undefined), false);
    assert.equal(adminLinkAllowPlainHttp(''), false);
    assert.equal(adminLinkAllowPlainHttp('false'), false);
    assert.equal(adminLinkAllowPlainHttp(' true '), true);
  });

  it('stops the manager at startup on any other value, naming itself', () => {
    for (const raw of ['yes', '1', 'TRUE', 'on']) {
      assert.throws(() => adminLinkAllowPlainHttp(raw), /ADMIN_LINK_ALLOW_PLAIN_HTTP/, raw);
    }
  });
});
