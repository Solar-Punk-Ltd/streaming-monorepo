import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { beeApiBind, boundHost } from '../src/boundHost.js';
import { loadConfig, ROOT_DIR } from '../src/config.js';

const BOUND_HOST_PATH = join(ROOT_DIR, 'deploy', 'scripts', 'bound-host.sh');

/** Run `snippet` with the real `bound-host.sh` sourced, in an environment holding only `env`. */
function inBoundHost(snippet: string, env: Readonly<Record<string, string>> = {}): string {
  return execFileSync('bash', ['-c', `source "$1"\n${snippet}`, 'bash', BOUND_HOST_PATH], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  }).trim();
}

/**
 * The harness dials a port where the deploy bound it, so its reading of a bind setting has to be the
 * one the deploy scripts share. These run the real shell functions over the same inputs and compare.
 */
describe('boundHost mirrors bound-host.sh', () => {
  for (const bind of ['', '0.0.0.0', '::', '[::]', '198.51.100.4', '127.0.0.1']) {
    it(`reads the bind "${bind}" the way bound_host does`, () => {
      assert.equal(boundHost(bind, '172.17.0.1'), inBoundHost(`bound_host "${bind}" 172.17.0.1`));
    });
  }

  for (const network of ['', 'host']) {
    it(`takes a Bee node's bind from the setting bee_api_bind names under COMPOSE_NETWORK="${network}"`, () => {
      const env = {
        COMPOSE_NETWORK: network,
        BEE_GATEWAY_API_BIND: '198.51.100.4',
        BEE_GATEWAY_API_LISTEN: '203.0.113.5',
      };
      assert.equal(beeApiBind('BEE_GATEWAY', env), inBoundHost('bee_api_bind BEE_GATEWAY', env));
    });
  }
});

const roots: string[] = [];

after(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureRoot(root: string, engine: { name: string; text: string } = { name: 'srs', text: '' }): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-bound-'));
  roots.push(dir);
  writeFileSync(join(dir, '.env'), root);
  mkdirSync(join(dir, 'engines', engine.name), { recursive: true });
  writeFileSync(join(dir, 'engines', engine.name, '.env'), engine.text);
  return dir;
}

describe('the bind settings the suite reads off the deployment', () => {
  it('names every bridge-bound port it dials, with an empty bind where the env files set none', () => {
    const cfg = loadConfig({ env: {}, rootDir: fixtureRoot('') });

    assert.deepEqual(cfg.bridgeAddress, '');
    assert.deepEqual(cfg.boundPorts, [
      { port: cfg.ports.beeUploaderApi, bind: '' },
      { port: cfg.ports.beeGatewayApi, bind: '' },
      { port: cfg.ports.srsHttp, bind: '' },
      { port: cfg.omeHlsPort, bind: '' },
    ]);
  });

  it('reads each bind setting and the bridge address from the env files', () => {
    const rootDir = fixtureRoot(
      [
        'DOCKER_BRIDGE_ADDRESS=172.17.0.1',
        'BEE_UPLOADER_API_BIND=198.51.100.1',
        'BEE_GATEWAY_API_BIND=198.51.100.2',
        'SRS_HTTP_BIND=198.51.100.3',
      ].join('\n'),
      { name: 'srs', text: 'OME_HTTP_BIND=198.51.100.4\n' },
    );
    const cfg = loadConfig({ env: {}, rootDir });

    assert.equal(cfg.bridgeAddress, '172.17.0.1');
    assert.deepEqual(
      cfg.boundPorts.map((bound) => bound.bind),
      ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4'],
    );
  });

  it('takes a Bee node bind from its *_API_LISTEN under host networking', () => {
    const rootDir = fixtureRoot(
      [
        'COMPOSE_NETWORK=host',
        'BEE_UPLOADER_API_BIND=198.51.100.1',
        'BEE_UPLOADER_API_LISTEN=203.0.113.1',
        'BEE_GATEWAY_API_LISTEN=203.0.113.2',
      ].join('\n'),
    );
    const cfg = loadConfig({ env: {}, rootDir });

    assert.deepEqual(
      cfg.boundPorts.slice(0, 2).map((bound) => bound.bind),
      ['203.0.113.1', '203.0.113.2'],
    );
  });

  // These land in a curl line the harness hands to a shell.
  it('refuses a bind setting or a bridge address that is not an address', () => {
    for (const line of ['BEE_GATEWAY_API_BIND=$(reboot)', 'DOCKER_BRIDGE_ADDRESS=a b']) {
      assert.throws(() => loadConfig({ env: {}, rootDir: fixtureRoot(`${line}\n`) }), /Invalid/, line);
    }
  });
});
