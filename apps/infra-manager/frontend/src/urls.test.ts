/**
 * Which host a deployment's links are built from, tested without a browser.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 *
 * `profile.host` is a *deploy* target: "localhost", an ssh alias, or
 * `user@host`. An alias is a key into the manager's ssh config and resolves
 * nowhere else, so a link composed from it (a viewer page, a Bee API, an SRT
 * publish URL) pointed at a name no browser could dial. `network_host` is that
 * target resolved server-side, and these pin that it is what wins.
 *
 * Every case passes a non-empty `serverHost`, because the fallback behind it is
 * `window.location.hostname` and there is no window under node.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SRS_SERVICE } from '@streaming-infra-manager/common';

import type { Profile } from './types';
import { hostFor, srtPublishSettings, srtPublishUrl } from './urls';

const SERVER_HOST = 'manager.example';

function profile(over: Partial<Profile>): Profile {
  return { name: 'rung-1', port_slot: 1, ...over } as Profile;
}

describe('the host a deployment is dialled at', () => {
  it('prefers the resolved network_host over the deploy target', () => {
    const host = hostFor(profile({ host: 'bee-host-1', network_host: '203.0.113.7' }), SERVER_HOST);

    assert.equal(host, '203.0.113.7');
  });

  it('falls back to host when the manager sends no network_host', () => {
    for (const network_host of [undefined, null, '', '   ']) {
      assert.equal(
        hostFor(profile({ host: 'stream.example', network_host }), SERVER_HOST),
        'stream.example',
        `network_host ${JSON.stringify(network_host)}`,
      );
    }
  });

  it('sends a local deployment to the server the page was loaded from', () => {
    // `native` is the stack's sentinel for a service running outside compose on
    // the deploy host, not an address. See is_native in deploy/scripts/_lib.sh.
    for (const local of ['localhost', '0.0.0.0', '127.0.0.1', 'native']) {
      assert.equal(hostFor(profile({ host: local }), SERVER_HOST), SERVER_HOST, `host ${JSON.stringify(local)}`);
      // A target that resolved to a local address overrides a remote-looking
      // deploy target. An *empty* network_host does not, and defers to host.
      assert.equal(
        hostFor(profile({ host: 'bee-host-1', network_host: local }), SERVER_HOST),
        SERVER_HOST,
        `network_host ${JSON.stringify(local)}`,
      );
    }
    assert.equal(hostFor(profile({ host: '' }), SERVER_HOST), SERVER_HOST);
  });

  it('keeps a deploy target that resolved to nothing, rather than losing the address', () => {
    // resolveNetworkHost echoes a name no Host block matches straight back, so
    // an unresolvable alias still reaches the browser as network_host.
    assert.equal(hostFor(profile({ host: 'bee-host-1', network_host: 'bee-host-1' }), SERVER_HOST), 'bee-host-1');
  });

  it('has no host of its own to offer when the profile carries neither', () => {
    assert.equal(hostFor(profile({}), SERVER_HOST), SERVER_HOST);
  });
});

describe('the SRT line a broadcaster points at an SRS deployment', () => {
  const srs = profile({
    host: 'stream.example',
    containers: [{ service: SRS_SERVICE, ports: { SRS_SRT_PORT: 10011 } }] as unknown as Profile['containers'],
  });

  it('names the default application and stream, with no key', () => {
    assert.equal(srtPublishUrl(srs, SERVER_HOST), 'srt://stream.example:10011?streamid=#!::r=live/stream,m=publish');
  });

  it('appends a passphrase that is safe inside an address', () => {
    assert.deepEqual(srtPublishSettings(srs, SERVER_HOST, ' s3cret.pass_word~-1 '), {
      server: 'srt://stream.example:10011?streamid=#!::r=live/stream,m=publish&passphrase=s3cret.pass_word~-1',
      passphraseRoute: 'server',
    });
    assert.equal(
      srtPublishUrl(srs, SERVER_HOST, ' secret '),
      'srt://stream.example:10011?streamid=#!::r=live/stream,m=publish&passphrase=secret',
    );
  });

  it("leaves out a passphrase an address cannot carry, for OBS's own passphrase field", () => {
    // OBS ends a value at `&` and reads `+` as a space, so this one would reach SRT cut short.
    assert.deepEqual(srtPublishSettings(srs, SERVER_HOST, 'p&ss word#1'), {
      server: 'srt://stream.example:10011?streamid=#!::r=live/stream,m=publish',
      passphraseRoute: 'authentication',
    });
    assert.equal(
      srtPublishUrl(srs, SERVER_HOST, 'p&ss word#1'),
      'srt://stream.example:10011?streamid=#!::r=live/stream,m=publish',
    );
  });

  it('says there is no passphrase when none is given', () => {
    assert.deepEqual(srtPublishSettings(srs, SERVER_HOST, null), {
      server: 'srt://stream.example:10011?streamid=#!::r=live/stream,m=publish',
      passphraseRoute: 'none',
    });
  });
});
