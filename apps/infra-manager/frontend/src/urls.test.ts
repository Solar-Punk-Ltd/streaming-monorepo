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

import { OME_SERVICE, SRS_SERVICE } from '@streaming-infra-manager/common';

import type { Profile } from './types';
import { hostFor, rtmpPublishSettings, srtPublishSettings, srtPublishUrl } from './urls';

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

describe('the RTMP server and stream key a broadcaster gives OBS for an SRS deployment', () => {
  const containersOf = (ports: Record<string, number>, service = SRS_SERVICE) =>
    [{ service, ports }] as unknown as Profile['containers'];
  it('offers RTMP on every SRS deployment, because its engine takes it and the firewall is the operator\'s', () => {
    const srs = profile({
      host: 'stream.example',
      port_slot: 6,
      containers: containersOf({ SRS_SRT_PORT: 10061, SRS_RTMP_PORT: 10062 }),
    });

    assert.notEqual(rtmpPublishSettings(srs, SERVER_HOST), null);
  });

  it('names the same application and stream as the SRT line, and carries no key and no passphrase', () => {
    const srs = profile({
      host: 'stream.example',
      port_slot: 6,
      has_srt_passphrase: true,
      containers: containersOf({ SRS_SRT_PORT: 10061, SRS_RTMP_PORT: 10062 }),
    });

    assert.deepEqual(rtmpPublishSettings(srs, SERVER_HOST), {
      server: 'rtmp://stream.example:10062/live',
      streamKey: 'stream',
    });
  });

  it("takes the slot's RTMP port while the container's record does not carry one yet", () => {
    const recordedBefore = profile({
      host: 'stream.example',
      port_slot: 6,
      containers: containersOf({ SRS_SRT_PORT: 10061 }),
    });

    assert.equal(
      rtmpPublishSettings(recordedBefore, SERVER_HOST)?.server,
      'rtmp://stream.example:10062/live',
    );
  });

  it('offers no RTMP at slot 0 with no recorded port, rather than guess one', () => {
    const unslotted = profile({
      host: 'stream.example',
      port_slot: 0,
      containers: containersOf({ SRS_SRT_PORT: 10080 }),
    });

    assert.equal(rtmpPublishSettings(unslotted, SERVER_HOST), null);
  });

  it('offers no RTMP for OvenMediaEngine, which takes SRT alone, or for a deployment with no media server', () => {
    const ome = profile({
      host: 'stream.example',
      components: [OME_SERVICE, 'stream-uploader'],
      containers: containersOf({ OME_SRT_PORT: 10061 }, OME_SERVICE),
    });
    const viewer = profile({
      host: 'stream.example',
      kind: 'viewer',
      containers: [] as unknown as Profile['containers'],
    });

    assert.equal(rtmpPublishSettings(ome, SERVER_HOST), null);
    assert.equal(rtmpPublishSettings(viewer, SERVER_HOST), null);
  });

  it('offers no RTMP once a deployment runs OvenMediaEngine, though a record of its SRS is left', () => {
    const switched = profile({
      host: 'stream.example',
      components: [OME_SERVICE, 'stream-uploader'],
      containers: [
        { service: SRS_SERVICE, ports: { SRS_RTMP_PORT: 10062 } },
        { service: OME_SERVICE, ports: { OME_SRT_PORT: 10061 } },
      ] as unknown as Profile['containers'],
    });

    assert.equal(rtmpPublishSettings(switched, SERVER_HOST), null);
  });
});
