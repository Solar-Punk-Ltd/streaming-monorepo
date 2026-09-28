/**
 * What a port in the Containers card is, read off its key, tested without a
 * browser.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 *
 * Every port was a link to http://host:port, an SRT listener and a Swarm
 * peer port included. A link says "this opens in your browser", which is
 * false for those and misleading for an API kept behind the firewall.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PUBLIC_PORT_ROLES } from '@streaming-infra-manager/common';

import { endpointAddress, endpointKindOf } from './endpoints';

describe('what a port is, by its key', () => {
  it('knows an SRT listener is UDP ingest, not a page', () => {
    const kind = endpointKindOf('SRS_SRT_PORT');

    assert.equal(kind.protocol, 'srt');
    assert.equal(kind.opensInBrowser, false);
    assert.equal(endpointAddress(kind, 'stream.example', 10011), 'srt://stream.example:10011');
  });

  it('knows a Swarm peer port is for other nodes, not a browser', () => {
    const kind = endpointKindOf('BEE_UPLOADER_P2P_PORT');

    assert.equal(kind.protocol, 'swarm-p2p');
    assert.equal(kind.audience, 'public');
    assert.equal(kind.opensInBrowser, false);
    assert.equal(endpointAddress(kind, 'stream.example', 10016), 'stream.example:10016');
  });

  it('keeps an API off the browser, even though it speaks HTTP', () => {
    for (const key of ['API_PORT', 'BEE_UPLOADER_API_PORT', 'SRS_HTTP_API_PORT']) {
      const kind = endpointKindOf(key);
      assert.equal(kind.protocol, 'http', key);
      assert.equal(kind.audience, 'administrative', key);
      assert.equal(kind.opensInBrowser, false, key);
    }
  });

  it('links the viewer page, the one port meant for a browser', () => {
    const kind = endpointKindOf('CLIENT_PORT');

    assert.equal(kind.audience, 'public');
    assert.equal(kind.opensInBrowser, true);
    assert.equal(endpointAddress(kind, 'stream.example', 10014), 'http://stream.example:10014');
  });

  it("calls the engine's HLS output internal, HTTP or not", () => {
    const kind = endpointKindOf('SRS_HTTP_PORT');

    assert.equal(kind.protocol, 'http');
    assert.equal(kind.audience, 'internal');
    assert.equal(kind.opensInBrowser, false);
  });

  it('knows RTMP ingest as its own protocol, and not a page', () => {
    assert.equal(endpointKindOf('SRS_RTMP_PORT').protocol, 'rtmp');
    assert.equal(endpointKindOf('SRS_RTMP_PORT').opensInBrowser, false);
    assert.equal(
      endpointAddress(endpointKindOf('SRS_RTMP_PORT'), 'stream.example', 10012),
      'rtmp://stream.example:10012',
    );
  });

  it('does not call RTMP ingest public, because the firewall keeps it closed', () => {
    // PUBLIC_PORT_ROLES carries no RTMP role, so the generated rules drop the
    // port from outside. The cell said public anyway, which is the one thing an
    // operator cannot check from the screen.
    const kind = endpointKindOf('SRS_RTMP_PORT');

    assert.equal(kind.audience, 'internal');
    assert.match(kind.label, /the firewall does not open it/);
  });

  it('offers no RTMP address to copy while the firewall does not open RTMP', () => {
    // An address the ingest cannot serve sends a streamer to a port that turns them away.
    const kind = endpointKindOf('SRS_RTMP_PORT');

    assert.equal(kind.offersAddress, false);
    assert.equal(
      PUBLIC_PORT_ROLES.some((role) => role.portVar === 'SRS_RTMP_PORT'),
      false,
      'the policy opens no RTMP port today',
    );
  });

  it('offers the RTMP address once the firewall policy opens RTMP', () => {
    const opened = [
      ...PUBLIC_PORT_ROLES,
      { group: 'rtmp_ingest', protocol: 'tcp', base: 10002, maxSlot: 100, portVar: 'SRS_RTMP_PORT', service: 'srs' },
    ] as const;
    const kind = endpointKindOf('SRS_RTMP_PORT', opened);

    assert.equal(kind.offersAddress, true);
    assert.equal(kind.audience, 'public');
    assert.equal(kind.label, 'RTMP ingest, TCP, public');
  });

  it('keeps offering every other address, as before', () => {
    for (const key of ['SRS_SRT_PORT', 'CLIENT_PORT', 'API_PORT', 'SRS_HTTP_PORT', 'BEE_UPLOADER_P2P_PORT', 'X_PORT']) {
      assert.equal(endpointKindOf(key).offersAddress, true, key);
    }
  });

  it('claims nothing about a key it does not know', () => {
    const kind = endpointKindOf('SOMETHING_NEW_PORT');

    assert.equal(kind.protocol, 'tcp');
    assert.equal(kind.opensInBrowser, false);
  });

  it('tells the three audiences apart in the label', () => {
    assert.match(endpointKindOf('CLIENT_PORT').label, /public/);
    assert.match(endpointKindOf('BEE_GATEWAY_API_PORT').label, /administrative/);
    assert.match(endpointKindOf('SRS_HTTP_PORT').label, /internal/);
  });
});
