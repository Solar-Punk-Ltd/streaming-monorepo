/**
 * The service as index.ts builds it: given the deployments and their recorded containers, it reaches a node through
 * its Bee API and opens no Docker connection, whatever host the deployment names.
 *
 * Unit test, no database and no network: the journal is in memory, the node's session and the chain are fakes, and a
 * Docker connection, were one opened, fails the test.
 */
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import pg from 'pg';
import type { ChequebookChainReader } from '../../src/domain/chequebook/ChequebookChainRegistry.js';
import { createChequebookOperationsService } from '../../src/domain/chequebook/createChequebookOperationsService.js';
import type { Profile } from '../../src/types/index.js';
import {
  InMemoryChequebookOperations,
  profileInstanceId,
  transferContext,
  transferIntent,
} from '../support/chequebookOperations.js';
import { syntheticTarget } from '../support/syntheticDockerBee.js';

const deployment = {
  instance_id: profileInstanceId,
  name: syntheticTarget.profile.name,
  port_slot: 1,
  host: 'bee-host',
  kind: 'streamer',
  components: null,
  status: 'RUNNING',
  created_at: new Date(0),
  updated_at: new Date(0),
  stack_version_id: 1,
} as Profile;
/** The port the deployment's reservation owns in the captured ownership, which its Bee container also recorded. */
const reserved = syntheticTarget.reservation.port;

function chainReader(): ChequebookChainReader {
  return {
    async chainId() {
      return 100;
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
      return { number: '500', hash: transferContext.startBlockHash, parentHash: `0x${'55'.repeat(32)}` };
    },
  };
}

/** A node's Bee API as the direct route's session sees it, counting what is sent through it. */
function beeSession() {
  let posts = 0;
  return {
    posts: () => posts,
    session: {
      async getAddresses() {
        return { ethereum: transferContext.nodeAddress };
      },
      async getWallet() {
        return {
          chainID: 100,
          walletAddress: transferContext.nodeAddress,
          chequebookContractAddress: transferContext.chequebookAddress,
          bzzBalance: '10000000000000000',
          nativeTokenBalance: '1',
        };
      },
      async getChequebookAddress() {
        return { chequebookAddress: transferContext.chequebookAddress };
      },
      async getChequebookBalance() {
        return { totalBalance: '10000000000000000', availableBalance: '10000000000000000' };
      },
      async depositChequebook() {
        posts++;
        return { transactionHash: `0x${'cd'.repeat(32)}` };
      },
      async withdrawChequebook() {
        posts++;
        return { transactionHash: `0x${'cd'.repeat(32)}` };
      },
      async getPendingTransactions() {
        return [];
      },
      assertUsable() {},
      dispose() {},
    },
  };
}

function directService(t: TestContext, host = deployment.host) {
  const pool = new pg.Pool({ connectionString: 'postgres://unused' });
  t.after(() => pool.end());
  const bee = beeSession();
  const urls: string[] = [];
  const repository = new InMemoryChequebookOperations();
  // The runtime index.ts passes: no Docker setting at all.
  const service = createChequebookOperationsService(
    pool,
    { rpcEndpoints: '{"100":"https://rpc.example.invalid"}' },
    {
      repository,
      profiles: { findByName: async () => ({ ...deployment, host }) },
      containers: {
        listApiContainers: async () => [
          {
            service: 'bee-uploader',
            ports: { BEE_UPLOADER_API_PORT: reserved },
            buildId: null,
            buildCommit: null,
            buildLabel: null,
          },
        ],
      },
      captureTarget: async () => structuredClone(syntheticTarget),
      createChainReader: () => chainReader(),
      createSession: (url) => {
        urls.push(url);
        return bee.session;
      },
      connectUnix: () => assert.fail('the direct route opens no Docker connection'),
      preparation: { timeoutMs: 3000 },
    },
  );
  t.after(() => service.shutdown());
  return { service, urls, posts: bee.posts, repository };
}

describe('the chequebook service built with the deployments and their containers', () => {
  it("takes the direct route: one move, through a session at the deployment's address and recorded port", async (t) => {
    const d = directService(t);
    const result = await d.service.submit(transferIntent());
    assert.equal(result.operation.state, 'submitted');
    assert.equal(d.posts(), 1);
    assert.deepEqual(d.urls, [`http://bee-host:${reserved}/`]);
  });

  it('reaches a user@host deployment at the host alone, with no Docker route to refuse the @', async (t) => {
    const d = directService(t, 'operator@bee.example.invalid');
    const result = await d.service.submit(transferIntent());
    assert.equal(result.operation.state, 'submitted');
    assert.equal(d.posts(), 1);
    assert.deepEqual(d.urls, [`http://bee.example.invalid:${reserved}/`]);
  });
});
