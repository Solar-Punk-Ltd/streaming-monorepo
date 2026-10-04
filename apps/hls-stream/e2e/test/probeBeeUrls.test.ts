import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolvePort } from '../src/ports.js';
import { probeReadUrl, probeWriteUrl } from '../src/probes/bee-urls.mjs';

/**
 * The probes read through the stage's gateway Bee API and write through its uploader Bee API. Which
 * stage is the operator's to name, in READ_URL and WRITE_URL or as the stage's PORT_SLOT, and an
 * unnamed stage is refused rather than defaulted to one slot's ports.
 */
describe('probe Bee addresses', () => {
  it('answers the addresses the settings name', () => {
    const env = { READ_URL: 'http://198.51.100.7:1733', WRITE_URL: 'http://198.51.100.7:1633', PORT_SLOT: '3' };
    assert.equal(probeReadUrl(env), 'http://198.51.100.7:1733');
    assert.equal(probeWriteUrl(env), 'http://198.51.100.7:1633');
  });

  it('derives both from the port slot on the bridge address, the way the deploy scripts publish them', () => {
    for (const slot of [0, 1, 7, 42, 99]) {
      const env = { PORT_SLOT: String(slot), DOCKER_BRIDGE_ADDRESS: '198.51.100.9' };
      assert.equal(probeReadUrl(env), `http://198.51.100.9:${resolvePort('BEE_GATEWAY_API_PORT', slot, {})}`);
      assert.equal(probeWriteUrl(env), `http://198.51.100.9:${resolvePort('BEE_UPLOADER_API_PORT', slot, {})}`);
    }
  });

  it('dials loopback only where no bridge address is named, as the deploy falls back to', () => {
    const env = { PORT_SLOT: '7' };
    assert.equal(probeReadUrl(env), `http://127.0.0.1:${resolvePort('BEE_GATEWAY_API_PORT', 7, {})}`);
    assert.equal(probeWriteUrl(env), `http://127.0.0.1:${resolvePort('BEE_UPLOADER_API_PORT', 7, {})}`);
  });

  it('refuses when neither the address nor the slot is named', () => {
    assert.throws(() => probeReadUrl({}), /READ_URL.*PORT_SLOT/);
    assert.throws(() => probeWriteUrl({}), /WRITE_URL.*PORT_SLOT/);
  });

  it('refuses a slot that deploy.sh would not create', () => {
    for (const slot of ['100', '-1', 'seven', '1.5']) {
      assert.throws(() => probeReadUrl({ PORT_SLOT: slot }), /PORT_SLOT/, slot);
    }
  });
});
