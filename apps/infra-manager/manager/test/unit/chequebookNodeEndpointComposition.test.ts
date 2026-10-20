/**
 * The production composition reads the chain through the manager's own
 * settings alone, on the direct route it takes to a node: for the transfer it
 * prepares, for the receipt polling that settles it, and for a manager
 * restarted while that polling was still owed. No node is asked for the
 * endpoint it was started with, and with no setting a transfer is refused as
 * `chain_endpoint_missing` before anything is sent. The deployment here is a
 * remote one, `user@host`.
 */
import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import pg from 'pg';
import { BEE_UPLOADER_SERVICE, type ChequebookOperation } from '@streaming-infra-manager/common';
import {
  createChequebookOperationsService,
  type ChequebookServiceDependencies,
} from '../../src/domain/chequebook/createChequebookOperationsService.js';
import type { ChequebookChainReader } from '../../src/domain/chequebook/ChequebookChainRegistry.js';
import {
  InMemoryChequebookOperations,
  syntheticTarget,
  transferContext,
  transferIntent,
} from '../support/chequebookOperations.js';
import { syntheticBeeNode } from '../support/connectedChequebook.js';
import { makeProfile } from '../support/profileFixtures.js';
import type { Profile } from '../../src/types/index.js';

const DEFAULT_ENDPOINT = 'https://funding.example.invalid';
/** A remote deployment, reached by its ssh account and address, whose Bee API is on the documentation range. */
const remote = makeProfile({
  name: syntheticTarget.profile.name,
  instance_id: syntheticTarget.profile.instanceId,
  kind: 'streamer',
  status: 'RUNNING',
  host: 'operator@203.0.113.9',
}) as unknown as Profile;
const quietLog = { info() {}, warn() {} };
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Answers the start block before the transfer and one canonical finalized success receipt after it. */
function chain(): { reader: ChequebookChainReader; settle(operation: ChequebookOperation): void } {
  let settled: ChequebookOperation | null = null;
  const hashAt = (number: bigint) =>
    number === 500n ? transferContext.startBlockHash : `0x${number.toString(16).padStart(64, '0')}`;
  const transaction = () => ({
    hash: settled!.transactionHash!,
    chainId: 100,
    from: settled!.nodeAddress,
    to: settled!.tokenAddress,
    data: `0xa9059cbb${settled!.chequebookAddress.slice(2).padStart(64, '0')}${BigInt(settled!.amountPlur).toString(16).padStart(64, '0')}`,
    nonce: '9',
    value: '0',
    blockNumber: '501',
    blockHash: hashAt(501n),
  });
  return {
    settle(operation) {
      settled = operation;
    },
    reader: {
      async chainId() {
        return 100;
      },
      async transactionCount() {
        return '8';
      },
      async blockTransactions() {
        return null;
      },
      async transaction(hash) {
        return settled && hash === settled.transactionHash ? transaction() : null;
      },
      async receipt(hash) {
        return settled && hash === settled.transactionHash
          ? {
              transactionHash: hash,
              from: settled.nodeAddress,
              to: settled.tokenAddress,
              blockNumber: '501',
              blockHash: hashAt(501n),
              status: 'success' as const,
            }
          : null;
      },
      async blockHeader(block) {
        const number = block === 'finalized' || block === 'latest' ? (settled ? 501n : 500n) : block;
        return { number: String(number), hash: hashAt(number), parentHash: hashAt(number - 1n) };
      },
    },
  };
}

/** `chainEndpoint` is the manager's default endpoint, or null for none. */
function composition(t: TestContext, chainEndpoint: string | null = DEFAULT_ENDPOINT) {
  const repository = new InMemoryChequebookOperations();
  const pool = new pg.Pool({ connectionString: 'postgres://unused' });
  t.after(() => pool.end());
  const bee = syntheticBeeNode();
  const scripted = chain();
  const endpoints: string[] = [];
  const dependencies: ChequebookServiceDependencies = {
    repository,
    captureTarget: async () => structuredClone(syntheticTarget),
    profiles: { findByName: async (name) => (name === remote.name ? structuredClone(remote) : null) },
    containers: {
      listApiContainers: async () => [
        {
          service: BEE_UPLOADER_SERVICE,
          ports: { BEE_UPLOADER_API_PORT: syntheticTarget.reservation.port },
          buildId: null,
          buildCommit: null,
          buildLabel: null,
        },
      ],
    },
    createSession: bee.createSession,
    createChainReader: (endpoint) => {
      endpoints.push(endpoint);
      return scripted.reader;
    },
    preparation: { timeoutMs: 3000 },
    receiptPolling: { intervalMs: 5, log: quietLog },
  };
  const start = () => {
    const service = createChequebookOperationsService(
      pool,
      { rpcEndpoints: undefined, chainEndpoint: chainEndpoint ?? undefined },
      dependencies,
    );
    t.after(() => service.shutdown());
    return service;
  };
  return { bee, scripted, endpoints, repository, start };
}

async function settledWithin(
  repository: InMemoryChequebookOperations,
  id: string,
): Promise<ChequebookOperation | null> {
  for (let round = 0; round < 400; round++) {
    const row = await repository.findById(id);
    if (row?.state === 'settled') return row;
    await pause();
  }
  return repository.findById(id);
}

it("prepares a transfer on a remote node through its Bee API, reading the chain through the manager's endpoint", async (t) => {
  const c = composition(t);
  const result = await c.start().submit(transferIntent());
  assert.equal(result.operation.state, 'submitted');
  assert.deepEqual([...new Set(c.endpoints)], [DEFAULT_ENDPOINT]);
  assert.deepEqual([...new Set(c.bee.sessionUrls())], ['http://203.0.113.9:11633/']);
  assert.equal(c.bee.posts(), 1);
});

it('polls that transfer to settlement through the same endpoint, opening no session to the node', async (t) => {
  const c = composition(t);
  const service = c.start();
  const operation = (await service.submit(transferIntent())).operation;
  const sessions = c.bee.sessionUrls().length;
  c.scripted.settle(operation);
  service.start();
  assert.equal((await settledWithin(c.repository, operation.id))?.state, 'settled');
  assert.deepEqual([...new Set(c.endpoints)], [DEFAULT_ENDPOINT]);
  assert.equal(c.bee.sessionUrls().length, sessions, 'receipts and finality read the chain alone');
});

it('lets a restarted manager poll a transfer it did not prepare through the same endpoint', async (t) => {
  const c = composition(t);
  const operation = (await c.start().submit(transferIntent())).operation;
  const sessions = c.bee.sessionUrls().length;
  c.scripted.settle(operation);
  const restarted = c.start();
  restarted.start();
  assert.equal((await settledWithin(c.repository, operation.id))?.state, 'settled');
  assert.deepEqual([...new Set(c.endpoints)], [DEFAULT_ENDPOINT]);
  assert.equal(c.bee.sessionUrls().length, sessions, 'the restarted manager asked the node for nothing');
  assert.equal(c.bee.posts(), 1);
});

it('refuses a transfer as chain_endpoint_missing when the manager names no endpoint, and sends nothing', async (t) => {
  const c = composition(t, null);
  await assert.rejects(
    c.start().submit(transferIntent()),
    (error: unknown) =>
      error instanceof Error && (error as { refusal?: { cause?: string } }).refusal?.cause === 'chain_endpoint_missing',
  );
  assert.deepEqual(c.endpoints, [], 'no chain reader was made');
  assert.equal(c.bee.posts(), 0);
});
