import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chequebookFundingRefusal, readChequebookFunding } from '../src/harness/chequebookFunding.js';
import type { Host, ServiceTarget } from '../src/harness/host.js';
import type { PublisherNode } from '../src/harness/publishers.js';

/** A stage whose every chequebook is empty, answering at the address each read is dialled on. */
function dryHost(addressOf: (target: ServiceTarget) => string): Host {
  return {
    localJson: async () => ({ availableBalance: '0', totalBalance: '0' }),
    hostAddress: async (target: ServiceTarget) => addressOf(target),
  } as unknown as Host;
}

const node = (rung: string, url: string, port: number, address?: string): PublisherNode => ({
  rungs: [rung],
  url,
  batch: 'abcdef12…',
  port,
  address,
});

/** The refusal hands the operator a command to run on the deployment host, so it names a reachable address. */
describe('the deposit command a funding refusal prints', () => {
  it('names each node where it answers on the deployment host', async () => {
    const nodes = [
      node('480p', 'http://172.17.0.1:11071', 11_071, '172.17.0.1'),
      node('720p', 'http://198.51.100.4:11073', 11_073, '198.51.100.4'),
    ];
    const host = dryHost((target) => (typeof target === 'number' ? 'localhost' : (target.address ?? 'localhost')));

    const refusal = chequebookFundingRefusal(await readChequebookFunding(host, nodes)) ?? '';

    assert.match(refusal, /curl -sS -XPOST 'http:\/\/172\.17\.0\.1:11071\/chequebook\/deposit\?amount=\d+'/);
    assert.match(refusal, /curl -sS -XPOST 'http:\/\/198\.51\.100\.4:11073\/chequebook\/deposit\?amount=\d+'/);
  });

  it('names the address the deploy bound a single node named by its service to', async () => {
    const host = dryHost(() => '172.17.0.1');

    const refusal =
      chequebookFundingRefusal(await readChequebookFunding(host, [node('all', 'http://bee-uploader:1633', 10_075)])) ??
      '';

    assert.match(refusal, /'http:\/\/172\.17\.0\.1:10075\/chequebook\/deposit/);
  });
});
