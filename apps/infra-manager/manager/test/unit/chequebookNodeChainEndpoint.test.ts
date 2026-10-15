/**
 * The chain endpoint a Bee container was started with, and what the chain
 * registry does with it: nothing.
 *
 * The Docker route can still read the endpoint off a container's command, and
 * that parser stays with the Docker route until it is removed. The registry
 * never uses it: a transfer, its receipts and its recovery read the chain
 * through the manager's own settings alone, CHEQUEBOOK_RPC_ENDPOINTS and then
 * FUNDING_RPC_URL or BEE_RPC_ENDPOINT, and with neither a transfer is refused
 * as `chain_endpoint_missing`, whatever endpoint its node names.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChequebookRefusalCause } from '@streaming-infra-manager/common';
import { nodeChainEndpoint } from '../../src/domain/chequebook/DockerBeeBinding.js';
import {
  ChequebookChainRegistry,
  type ChequebookChainReader,
} from '../../src/domain/chequebook/ChequebookChainRegistry.js';
import { ChainReadError } from '../../src/domain/errors/ChainReadError.js';

const node = `0x${'ab'.repeat(20)}`;
const inspectWith = (Cmd: unknown) => ({ Config: { Cmd } });
const reader = (chainId = 100, unreachable = false): ChequebookChainReader => ({
  async chainId() {
    if (unreachable) throw new Error('fetch failed https://node-rpc.example.invalid/node-key');
    return chainId;
  },
  async transactionCount() {
    return '8';
  },
  async transaction() {
    return null;
  },
  async receipt() {
    return null;
  },
  async blockTransactions() {
    return null;
  },
  async blockHeader() {
    return null;
  },
});
const refusedAs = (cause: ChequebookRefusalCause) => (error: unknown) => {
  assert.ok(error instanceof ChainReadError, String(error));
  assert.equal(error.refusal.cause, cause);
  assert.equal(
    JSON.stringify({ ...error, message: error.message }).includes('example.invalid'),
    false,
    'no endpoint reaches the error',
  );
  return true;
};

describe('the chain endpoint a Bee container was started with', () => {
  it('reads the flag the stack passes, in either spelling cobra accepts', () => {
    assert.equal(
      nodeChainEndpoint(
        inspectWith([
          'start',
          '--api-addr=:1633',
          '--blockchain-rpc-endpoint=https://node-rpc.example.invalid/node-key',
          '--full-node=false',
        ]),
      ),
      'https://node-rpc.example.invalid/node-key',
    );
    assert.equal(
      nodeChainEndpoint(
        inspectWith(['start', '--blockchain-rpc-endpoint', 'https://node-rpc.example.invalid/node-key']),
      ),
      'https://node-rpc.example.invalid/node-key',
    );
  });

  it('takes the last occurrence, as the flag parser does', () => {
    assert.equal(
      nodeChainEndpoint(
        inspectWith([
          'start',
          '--blockchain-rpc-endpoint=https://first.example.invalid',
          '--blockchain-rpc-endpoint=https://second.example.invalid',
        ]),
      ),
      'https://second.example.invalid',
    );
  });

  it('answers none when the flag is absent, empty or unreadable', () => {
    for (const inspect of [
      inspectWith(['start', '--full-node=false']),
      inspectWith(['start', '--blockchain-rpc-endpoint=']),
      inspectWith(['start', '--blockchain-rpc-endpoint']),
      inspectWith(null),
      inspectWith('start --blockchain-rpc-endpoint=https://x.example.invalid'),
      inspectWith([7, { flag: true }]),
      {},
      { Config: null },
      null,
    ]) {
      assert.equal(nodeChainEndpoint(inspect), null, JSON.stringify(inspect));
    }
  });

  it('does not take a neighbouring flag that only starts the same way', () => {
    assert.equal(nodeChainEndpoint(inspectWith(['start', '--blockchain-rpc-endpoint-timeout=5s'])), null);
  });
});

describe('the chain registry never reads a node', () => {
  const nodeEndpoint = 'https://node-rpc.example.invalid/node-key';

  it('refuses a transfer being prepared as chain_endpoint_missing with no setting, whatever endpoint its node names', async () => {
    let created = 0;
    const registry = new ChequebookChainRegistry(undefined, () => {
      created++;
      return reader();
    });
    await assert.rejects(registry.forPreparedNode(100, node, nodeEndpoint), refusedAs('chain_endpoint_missing'));
    assert.equal(created, 0, "no reader was made for the node's endpoint");
  });

  it('never calls the node reader for a saved transfer, and says the endpoint is missing with no setting', async () => {
    const registry = new ChequebookChainRegistry(undefined, () => reader());
    let reads = 0;
    const readNode = async () => {
      reads++;
      return nodeEndpoint;
    };
    await assert.rejects(registry.forSavedNode(100, node, readNode), refusedAs('chain_endpoint_missing'));
    assert.equal(reads, 0);
  });

  it("reads a prepared and a saved transfer through the manager's default endpoint, never the node's", async () => {
    const created: string[] = [];
    let reads = 0;
    const registry = new ChequebookChainRegistry(
      undefined,
      (endpoint) => {
        created.push(endpoint);
        return reader();
      },
      { defaultEndpoint: 'https://funding.example.invalid' },
    );
    await registry.forPreparedNode(100, node, nodeEndpoint);
    await registry.forSavedNode(100, node, async () => {
      reads++;
      return nodeEndpoint;
    });
    assert.deepEqual(created, ['https://funding.example.invalid', 'https://funding.example.invalid']);
    assert.equal(reads, 0);
  });

  it('reads a configured chain through its configured endpoint, for a prepared and a saved transfer alike', async () => {
    const created: string[] = [];
    const registry = new ChequebookChainRegistry(
      '{"100":"https://configured.example.invalid"}',
      (endpoint) => {
        created.push(endpoint);
        return reader();
      },
      { defaultEndpoint: 'https://funding.example.invalid' },
    );
    await registry.forPreparedNode(100, node, nodeEndpoint);
    await registry.forSavedNode(100, node, async () => assert.fail('the node is never read'));
    assert.deepEqual(created, ['https://configured.example.invalid', 'https://configured.example.invalid']);
  });

  it('refuses the default endpoint on the wrong chain, and one that does not answer, for a saved transfer too', async () => {
    const options = { defaultEndpoint: 'https://funding.example.invalid' };
    await assert.rejects(
      new ChequebookChainRegistry(undefined, () => reader(1), options).forSavedNode(100, node, async () => null),
      refusedAs('wrong_chain'),
    );
    await assert.rejects(
      new ChequebookChainRegistry(undefined, () => reader(100, true), options).forPreparedNode(100, node, null),
      refusedAs('chain_unreachable'),
    );
  });

  it('refuses a chain with no pinned token whatever the settings or the node say', async () => {
    await assert.rejects(
      new ChequebookChainRegistry(undefined, () => reader(31337), {
        defaultEndpoint: 'https://funding.example.invalid',
      }).forPreparedNode(31337, node, nodeEndpoint),
      refusedAs('unsupported_chain'),
    );
  });
});
