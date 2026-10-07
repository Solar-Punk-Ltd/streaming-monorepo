import { describe, expect, it } from 'vitest';

import {
  addressSpaceOf,
  detectLocalNetworkAccess,
  localNetworkRequestInit,
  supportsLocalNetworkRequests,
} from '@/swarm/addressSpace';

describe('which network an address is on', () => {
  it.each([
    ['http://localhost:1633', 'loopback'],
    ['http://127.0.0.1:1633', 'loopback'],
    ['http://127.0.0.2:1633', 'loopback'],
    ['http://my.localhost:1633', 'loopback'],
    ['http://[::1]:1633', 'loopback'],
  ])('%s is this computer', (url, space) => {
    expect(addressSpaceOf(url)).toBe(space);
  });

  it.each([
    'http://10.0.0.5:1633',
    'http://172.16.0.1:1633',
    'http://172.31.255.254:1633',
    'http://192.168.1.20:1633',
    'http://bee.local:1633',
    'http://BEE.LOCAL:1633',
    'http://[fd12:3456::1]:1633',
    'http://[fc00::1]:1633',
  ])('%s is the local network', (url) => {
    expect(addressSpaceOf(url)).toBe('local');
  });

  it.each([
    'http://172.15.0.1:1633',
    'http://172.32.0.1:1633',
    'http://192.0.2.10:1633',
    'https://bee.example.com',
    'http://[2001:db8::1]:1633',
    'http://local.example.com:1633',
  ])('%s is the internet', (url) => {
    expect(addressSpaceOf(url)).toBe('public');
  });

  it('has no network for a path on this site, which carries the page’s own', () => {
    expect(addressSpaceOf('/bee')).toBeNull();
  });
});

describe('what a request to a local network node is sent with', () => {
  it('marks a plain http node on the local network as local, so Chrome lets an https page reach it', () => {
    expect(localNetworkRequestInit('http://192.168.1.20:1633/health')).toEqual({ targetAddressSpace: 'local' });
    expect(localNetworkRequestInit('http://bee.local:1633/health')).toEqual({ targetAddressSpace: 'local' });
  });

  it('marks nothing else, because a mark that does not match where the address is fails the request', () => {
    for (const url of [
      'http://localhost:1633/health',
      'https://192.168.1.20:1633/health',
      'https://bee.example.com/health',
      '/bee/health',
    ]) {
      expect(localNetworkRequestInit(url)).toEqual({});
    }
  });
});

describe('whether the browser has Local Network Access', () => {
  /** A Permissions API that knows only `known`, and refuses every other name as Chrome refuses an unknown one. */
  const knowing =
    (...known: string[]) =>
    async ({ name }: { name: string }) => {
      if (!known.includes(name)) {
        throw new TypeError(`The provided value '${name}' is not a valid enum value of type PermissionName.`);
      }
      return { state: 'prompt' };
    };

  it.each(['local-network-access', 'local-network', 'loopback-network'])(
    'reads it off the Permissions API knowing %s, which Chrome does while Request has no targetAddressSpace',
    async (name) => {
      expect(await detectLocalNetworkAccess(knowing(name))).toBe(true);
    },
  );

  it('finds none where the Permissions API knows none of the names', async () => {
    expect(await detectLocalNetworkAccess(knowing('geolocation'))).toBe(false);
  });

  it('finds none where there is no Permissions API', async () => {
    expect(await detectLocalNetworkAccess(undefined)).toBe(false);
  });

  it('asks once per page', () => {
    expect(supportsLocalNetworkRequests()).toBe(supportsLocalNetworkRequests());
  });
});
