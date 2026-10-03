/**
 * The address a pool string hands an uploader for a node deployed on this host.
 *
 * Unit test, no Docker and no dns: the operator's override, the in-container
 * check and the lookup are injected, so every shape runs on a laptop.
 *
 * Why the shapes are what they are. The manager binds every local bee API to the docker
 * bridge address and to nothing else, so the manager's public address answers on
 * those ports from nowhere at all, and an uploader is a container on this same
 * host. Inside the api container the bridge is what host.docker.internal resolves
 * to. The name cannot be passed on, because an uploader's compose service carries
 * no extra_hosts and the name resolves nowhere inside it on Linux.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bridgeGatewayOf,
  localBeeApiBindReader,
  localPublisherHostReader,
  resolveLocalPublisherHost,
} from '../../src/domain/localHost.js';
import { config } from '../../src/utils/config.js';

const BRIDGE = '10.200.0.1';
const DOCKER_HOST_NAME = 'host.docker.internal';

function spies() {
  const looked: string[] = [];
  const warnings: string[] = [];
  return {
    looked,
    warnings,
    warn: (message: string) => {
      warnings.push(message);
    },
    answers: async (hostname: string) => {
      looked.push(hostname);
      return BRIDGE;
    },
    fails: async (hostname: string) => {
      looked.push(hostname);
      throw new Error('ENOTFOUND host.docker.internal');
    },
  };
}

describe('resolveLocalPublisherHost', () => {
  it('takes the operator’s override as given, without asking dns', async () => {
    const spy = spies();
    const host = await resolveLocalPublisherHost({
      beeLocalHost: '10.42.0.1',
      isInContainer: () => true,
      lookupIpv4: spy.answers,
      warn: spy.warn,
    });
    assert.equal(host, '10.42.0.1');
    assert.deepEqual(spy.looked, []);
  });

  it('resolves an override that names the docker host, since the name reaches no uploader', async () => {
    const spy = spies();
    const host = await resolveLocalPublisherHost({
      beeLocalHost: DOCKER_HOST_NAME,
      isInContainer: () => true,
      lookupIpv4: spy.answers,
      warn: spy.warn,
    });
    assert.equal(host, BRIDGE);
    assert.deepEqual(spy.looked, [DOCKER_HOST_NAME]);
  });

  it('answers the bridge address as a literal when the manager runs in a container', async () => {
    const spy = spies();
    const host = await resolveLocalPublisherHost({
      beeLocalHost: null,
      isInContainer: () => true,
      lookupIpv4: spy.answers,
      warn: spy.warn,
    });
    assert.equal(host, BRIDGE);
    assert.deepEqual(spy.looked, [DOCKER_HOST_NAME]);
    assert.deepEqual(spy.warnings, []);
  });

  it('falls back to the name and warns once when the lookup fails', async () => {
    const spy = spies();
    const host = await resolveLocalPublisherHost({
      beeLocalHost: null,
      isInContainer: () => true,
      lookupIpv4: spy.fails,
      warn: spy.warn,
    });
    assert.equal(host, DOCKER_HOST_NAME);
    assert.equal(spy.warnings.length, 1);
    assert.ok(spy.warnings[0]!.includes(DOCKER_HOST_NAME), spy.warnings[0]);
  });

  it('answers the docker host by name when the manager runs natively', async () => {
    const spy = spies();
    const host = await resolveLocalPublisherHost({
      beeLocalHost: null,
      isInContainer: () => false,
      lookupIpv4: spy.answers,
      warn: spy.warn,
    });
    assert.equal(host, DOCKER_HOST_NAME);
    assert.deepEqual(spy.looked, []);
  });

  it('takes the override the config checked at startup when none is passed', async () => {
    // A blank or malformed BEE_LOCAL_HOST never gets this far: beeLocalHostSetting.test.ts.
    const spy = spies();
    const host = await resolveLocalPublisherHost({
      isInContainer: () => true,
      lookupIpv4: spy.answers,
      warn: spy.warn,
    });
    const override = config.beeLocalHost;
    assert.equal(host, override === null || override === DOCKER_HOST_NAME ? BRIDGE : override);
  });
});

/**
 * The reader is what the pool assembly calls, and it remembers an answer the
 * lookup actually produced. A failed lookup is not an answer: caching its
 * fallback would hand out the bare name for the life of the process while the
 * manager's own probe, which resolves that name inside its container, reads
 * every rung as reachable.
 */
describe('localPublisherHostReader', () => {
  it('asks dns again after a lookup that failed', async () => {
    const spy = spies();
    let attempts = 0;
    const read = localPublisherHostReader({
      beeLocalHost: null,
      isInContainer: () => true,
      lookupIpv4: async (hostname) => {
        attempts += 1;
        return attempts === 1 ? spy.fails(hostname) : spy.answers(hostname);
      },
      warn: spy.warn,
    });
    assert.equal(await read(), DOCKER_HOST_NAME);
    assert.equal(await read(), BRIDGE);
    assert.equal(await read(), BRIDGE);
    assert.deepEqual(spy.looked, [DOCKER_HOST_NAME, DOCKER_HOST_NAME]);
  });

  it('asks dns once when the lookup answered', async () => {
    const spy = spies();
    const read = localPublisherHostReader({
      beeLocalHost: null,
      isInContainer: () => true,
      lookupIpv4: spy.answers,
      warn: spy.warn,
    });
    assert.equal(await read(), BRIDGE);
    assert.equal(await read(), BRIDGE);
    assert.deepEqual(spy.looked, [DOCKER_HOST_NAME]);
  });

  it('warns when the docker host resolves to a public address, and still answers it', async () => {
    const spy = spies();
    const read = localPublisherHostReader({
      beeLocalHost: null,
      isInContainer: () => true,
      lookupIpv4: async () => '8.8.8.8',
      warn: spy.warn,
    });
    assert.equal(await read(), '8.8.8.8');
    assert.equal(spy.warnings.length, 1);
    assert.ok(spy.warnings[0]!.includes('8.8.8.8'), spy.warnings[0]);
  });
});

describe('localBeeApiBindReader', () => {
  // The address a local deployment's Bee APIs are bound to where nothing names
  // one. Only the bridge the daemon reports as its own: on Docker Desktop the
  // docker host resolves to an address the daemon has no interface on, and a
  // port published there would answer nowhere.
  it('answers the docker host’s address when it is the daemon’s bridge gateway', async () => {
    const read = localBeeApiBindReader({
      publisherHost: async () => BRIDGE,
      bridgeGateway: async () => BRIDGE,
      warn: () => assert.fail('no warning'),
    });
    assert.equal(await read(), BRIDGE);
  });

  it('answers none, and warns once, when the docker host is not the daemon’s bridge', async () => {
    const warnings: string[] = [];
    const read = localBeeApiBindReader({
      publisherHost: async () => '192.168.65.254',
      bridgeGateway: async () => BRIDGE,
      warn: (message) => void warnings.push(message),
    });
    assert.equal(await read(), null);
    assert.equal(await read(), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /BEE_UPLOADER_API_BIND/);
  });

  it('answers none for a name, which is what a manager running natively hands on', async () => {
    let asked = false;
    const read = localBeeApiBindReader({
      publisherHost: async () => DOCKER_HOST_NAME,
      bridgeGateway: async () => {
        asked = true;
        return BRIDGE;
      },
      warn: () => undefined,
    });
    assert.equal(await read(), null);
    assert.equal(asked, false);
  });

  it('answers none while the bridge cannot be read, and asks again next time', async () => {
    let calls = 0;
    const read = localBeeApiBindReader({
      publisherHost: async () => BRIDGE,
      bridgeGateway: async () => {
        calls += 1;
        if (calls === 1) throw new Error('connect ENOENT /var/run/docker.sock');
        return BRIDGE;
      },
      warn: () => undefined,
    });
    assert.equal(await read(), null);
    assert.equal(await read(), BRIDGE);
    assert.equal(await read(), BRIDGE);
    assert.equal(calls, 2);
  });
});

describe('bridgeGatewayOf', () => {
  it('reads the IPv4 gateway of the bridge network’s inspect', () => {
    assert.equal(
      bridgeGatewayOf({
        IPAM: {
          Config: [
            { Subnet: 'fd00::/64', Gateway: 'fd00::1' },
            { Subnet: '10.200.0.0/16', Gateway: BRIDGE },
          ],
        },
      }),
      BRIDGE,
    );
  });

  it('answers null for an inspect without one', () => {
    for (const inspect of [
      null,
      {},
      { IPAM: {} },
      { IPAM: { Config: [] } },
      { IPAM: { Config: [{ Gateway: 'not-an-ip' }] } },
    ]) {
      assert.equal(bridgeGatewayOf(inspect), null, JSON.stringify(inspect));
    }
  });
});
