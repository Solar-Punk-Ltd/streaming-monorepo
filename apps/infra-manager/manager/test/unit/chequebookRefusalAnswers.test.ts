/**
 * Every reason the manager refuses to prepare a transfer reaches the answer.
 *
 * Each case drives the production composition behind the real router and error
 * handler, breaks exactly one thing on the way to the node or the chain, and
 * reads the 503 back over HTTP: the cause the page keys its sentence on, and
 * the sentence itself. The node is reached through its Bee API at the
 * deployment's address and the port its Bee container recorded, which must be
 * the one the deployment's reservation owns. Nothing is admitted and nothing is
 * sent in any of them, and no answer carries upstream text or an endpoint.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it, type TestContext } from 'node:test';
import express from 'express';
import pg from 'pg';
import {
  chequebookRefusalSentence,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  SESSION_COOKIE_NAME,
  type ChequebookRefusalCause,
} from '@streaming-infra-manager/common';
import { createChequebookRouter } from '../../src/api/routes/chequebook.js';
import { createRequireSession } from '../../src/api/middleware/requireSession.js';
import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import type { AuthService } from '../../src/domain/auth/AuthService.js';
import type { ChequebookService } from '../../src/domain/ChequebookService.js';
import type { BeeWallet } from '../../src/domain/BeeClient.js';
import type { ChequebookChainReader } from '../../src/domain/chequebook/ChequebookChainRegistry.js';
import {
  createChequebookOperationsService,
  type ChequebookRuntime,
} from '../../src/domain/chequebook/createChequebookOperationsService.js';
import { BeeConnectionError } from '../../src/domain/errors/BeeConnectionError.js';
import { ChequebookProfileChangedError } from '../../src/domain/errors/ChequebookProfileChangedError.js';
import { ChequebookTargetChangedError } from '../../src/domain/errors/ChequebookTargetChangedError.js';
import type { Profile } from '../../src/types/index.js';
import {
  InMemoryChequebookOperations,
  profileInstanceId,
  syntheticTarget,
  transferContext,
  transferIntent,
} from '../support/chequebookOperations.js';
import { syntheticBeeNode } from '../support/connectedChequebook.js';

const configuredChain = '{"100":"https://rpc.example.invalid/private-token"}';

function chainReader(overrides: Partial<ChequebookChainReader> = {}): ChequebookChainReader {
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
    ...overrides,
  };
}

interface Breakage {
  readonly runtime?: Partial<ChequebookRuntime>;
  readonly status?: Profile['status'];
  readonly containers?: { service: string; ports: Record<string, number> }[];
  readonly capture?: () => Promise<typeof syntheticTarget>;
  readonly chainReader?: () => ChequebookChainReader;
  /** What the node answers for its wallet, or null for a node that does not answer it. */
  readonly wallet?: BeeWallet | null;
}

async function refusedDeposit(t: TestContext, breakage: Breakage) {
  const pool = new pg.Pool({ connectionString: 'postgres://unused' });
  t.after(() => pool.end());
  const repository = new InMemoryChequebookOperations();
  const node = syntheticBeeNode();
  const deployment = {
    instance_id: profileInstanceId,
    name: syntheticTarget.profile.name,
    port_slot: 1,
    host: 'bee-host',
    kind: 'streamer',
    components: null,
    status: breakage.status ?? 'RUNNING',
    created_at: new Date(0),
    updated_at: new Date(0),
    stack_version_id: 1,
  } as Profile;
  const service = createChequebookOperationsService(
    pool,
    { rpcEndpoints: configuredChain, ...breakage.runtime },
    {
      repository,
      profiles: { findByName: async () => deployment },
      containers: {
        listApiContainers: async () =>
          (
            breakage.containers ?? [
              { service: 'bee-uploader', ports: { BEE_UPLOADER_API_PORT: syntheticTarget.reservation.port } },
            ]
          ).map((container) => ({ ...container, buildId: null, buildCommit: null, buildLabel: null })),
      },
      captureTarget: breakage.capture ?? (async () => structuredClone(syntheticTarget)),
      createChainReader: breakage.chainReader ?? (() => chainReader()),
      createSession: (url) => {
        const session = node.createSession(url);
        const { wallet } = breakage;
        if (wallet === undefined) return session;
        return {
          ...session,
          getWallet: async () => {
            if (wallet === null) throw new BeeConnectionError();
            return structuredClone(wallet);
          },
        };
      },
      preparation: { timeoutMs: 3000 },
    },
  );
  t.after(() => service.shutdown());
  return {
    ...(await answerDeposit(t, service)),
    repository,
    sessions: () => node.sessionUrls().length,
    posts: () => node.requests().filter((request) => request.method === 'POST').length,
  };
}

/** Posts one deposit through the real router and error handler, as the page does, and reads the answer back. */
async function answerDeposit(t: TestContext, service: ReturnType<typeof createChequebookOperationsService>) {
  const app = express();
  app.use(express.json());
  app.use(
    createRequireSession({
      sessionFor: async () => ({
        user: { id: 7, username: 'operator', isAdmin: false },
        tokenHash: 'synthetic-hash',
        expiresAt: new Date(Date.now() + 60_000),
      }),
    } as unknown as AuthService),
  );
  app.use(createChequebookRouter({} as ChequebookService, service), errorHandler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const intent = transferIntent();
  const response = await fetch(`http://127.0.0.1:${address.port}/profiles/${intent.profileName}/chequebook/deposit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE_NAME}=synthetic-session`,
      [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
    },
    body: JSON.stringify({
      requestId: intent.requestId,
      profileInstanceId: intent.profileInstanceId,
      expectedAccountId: 7,
      amount: intent.amountPlur,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

function assertRefused(answer: Awaited<ReturnType<typeof refusedDeposit>>, cause: ChequebookRefusalCause) {
  assert.equal(answer.status, 503, answer.text);
  assert.deepEqual(answer.body, {
    error: 'chequebook_preparation_unavailable',
    cause,
    message: chequebookRefusalSentence({ cause }),
  });
  assert.equal(answer.repository.rows.size, 0, 'nothing was admitted');
  assert.equal(answer.posts(), 0, 'nothing was sent');
  for (const secret of ['rpc.example.invalid', 'private', 'example.invalid']) {
    assert.equal(answer.text.includes(secret), false, `the answer carries no ${secret}`);
  }
}

/** A refusal decided before any session to the node is opened. */
function assertRefusedBeforeTheNode(answer: Awaited<ReturnType<typeof refusedDeposit>>, cause: ChequebookRefusalCause) {
  assertRefused(answer, cause);
  assert.equal(answer.sessions(), 0, 'no session to the node was opened');
}

const otherChain = () =>
  chainReader({
    async chainId() {
      return 1;
    },
  });

describe('a refused transfer names its cause in the answer', { timeout: 20_000 }, () => {
  it('Bee container not found: no bee-uploader container is recorded for the deployment', async (t) => {
    assertRefusedBeforeTheNode(await refusedDeposit(t, { containers: [] }), 'bee_container_not_found');
  });

  it("Bee container unsupported: its recorded port is not the one the deployment's reservation owns", async (t) => {
    assertRefusedBeforeTheNode(
      await refusedDeposit(t, {
        containers: [
          { service: 'bee-uploader', ports: { BEE_UPLOADER_API_PORT: syntheticTarget.reservation.port + 10 } },
        ],
      }),
      'bee_container_unsupported',
    );
  });

  it('target changed: the deployment is deploying, stopping or removing', async (t) => {
    for (const status of ['DEPLOYING', 'STOPPING', 'REMOVING'] as const) {
      assertRefusedBeforeTheNode(await refusedDeposit(t, { status }), 'target_changed');
    }
  });

  it('target changed: the deployment is not in a state a transfer can own', async (t) => {
    assertRefusedBeforeTheNode(
      await refusedDeposit(t, {
        capture: async () => {
          throw new ChequebookTargetChangedError();
        },
      }),
      'target_changed',
    );
  });

  it('Bee unreadable: the node does not answer its wallet', async (t) => {
    assertRefused(await refusedDeposit(t, { wallet: null }), 'bee_unreadable');
  });

  it('unsupported chain: the node runs on a chain with no pinned BZZ token', async (t) => {
    assertRefused(
      await refusedDeposit(t, {
        wallet: {
          chainID: 31337,
          walletAddress: transferContext.nodeAddress,
          chequebookContractAddress: transferContext.chequebookAddress,
          bzzBalance: '1',
          nativeTokenBalance: '1',
        } as BeeWallet,
      }),
      'unsupported_chain',
    );
  });

  it('chain setting invalid: CHEQUEBOOK_RPC_ENDPOINTS does not parse', async (t) => {
    assertRefused(await refusedDeposit(t, { runtime: { rpcEndpoints: '{broken' } }), 'chain_setting_invalid');
  });

  it("chain endpoint missing: nothing is configured for the node's chain", async (t) => {
    assertRefused(
      await refusedDeposit(t, { runtime: { rpcEndpoints: '{"1":"https://rpc.example.invalid"}' } }),
      'chain_endpoint_missing',
    );
  });

  it("wrong chain: the manager's default endpoint answers for another chain than the node's", async (t) => {
    assertRefused(
      await refusedDeposit(t, {
        runtime: { rpcEndpoints: undefined, chainEndpoint: 'https://rpc.example.invalid/private-default' },
        chainReader: otherChain,
      }),
      'wrong_chain',
    );
  });

  it('chain unreachable: the endpoint does not answer', async (t) => {
    assertRefused(
      await refusedDeposit(t, {
        chainReader: () =>
          chainReader({
            async chainId() {
              throw new Error('fetch failed https://rpc.example.invalid/private-token');
            },
          }),
      }),
      'chain_unreachable',
    );
  });

  it("wrong chain: the endpoint answers for another chain than the node's", async (t) => {
    assertRefused(await refusedDeposit(t, { chainReader: otherChain }), 'wrong_chain');
  });

  it('unavailable: a failure nothing classified still answers a fixed sentence', async (t) => {
    assertRefusedBeforeTheNode(
      await refusedDeposit(t, {
        capture: async () => {
          throw new Error('private synthetic driver diagnostic');
        },
      }),
      'unavailable',
    );
  });

  it('a deployment removed or replaced since the page read it is answered with 409, not a refusal', async (t) => {
    const answer = await refusedDeposit(t, {
      capture: async () => {
        throw new ChequebookProfileChangedError();
      },
    });
    assert.equal(answer.status, 409, answer.text);
    assert.equal(answer.body.error, 'chequebook_profile_changed');
    assert.equal(answer.repository.rows.size, 0, 'nothing was admitted');
    assert.equal(answer.sessions(), 0, 'no session to the node was opened');
  });
});
