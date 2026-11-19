/**
 * What the admin reads of a sentence a port, a stage's Apply or a node wrote: every node address in it left out, a URL,
 * a host and its port, an IP address, and the rest as written.
 *
 * Unit test, no network. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ADDRESS_LEFT_OUT, addressFree } from '../../src/domain/funding/addressFree.js';

const OUT = ADDRESS_LEFT_OUT;

describe('a sentence as the admin reads it', () => {
  it('leaves out a URL, a host and its port, and an IP address, v4 or v6, with its port', () => {
    const cases: Array<[string, string]> = [
      ['GET http://bee.invalid:1633/stamps failed.', `GET ${OUT} failed.`],
      ['(https://node.example.invalid/health)', `(${OUT})`],
      ['connect ECONNREFUSED 192.0.2.10:1633', `connect ECONNREFUSED ${OUT}`],
      ['No route to 198.51.100.7.', `No route to ${OUT}.`],
      ['connect ECONNREFUSED ::1:5432', `connect ECONNREFUSED ${OUT}`],
      ['dial [2001:db8::5]:1633: i/o timeout', `dial ${OUT}: i/o timeout`],
      ['fe80::1 did not answer', `${OUT} did not answer`],
      ['2001:db8:0:0:0:0:0:5 refused it', `${OUT} refused it`],
      ['bee-uploader:1633 refused the connection', `${OUT} refused the connection`],
      ['ssh operator@stage-host.invalid:22 timed out', `ssh operator@${OUT} timed out`],
      ['localhost:1633, then bee.invalid:1633.', `${OUT}, then ${OUT}.`],
    ];
    for (const [written, read] of cases) assert.equal(addressFree(written), read, written);
  });

  it('keeps what names no node: times, image tags, versions, batches, transactions and request ids', () => {
    const kept = [
      'The Apply did not go through.',
      'Read at 2026-11-19T10:00:00.000Z, and again at 10:30.',
      'Pulling registry.invalid/example/uploader:1.4.2 and postgres:16-alpine failed.',
      `Batch 0x${'c5'.repeat(32)} in transaction 0x${'9a'.repeat(32)}.`,
      'Batch purchase 7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6 is set on pool-720p.',
      'The node refused it (402, “insufficient funds”).',
      'std::io failed in the client: stage-one is stopped.',
    ];
    for (const text of kept) assert.equal(addressFree(text), text);
  });
});
