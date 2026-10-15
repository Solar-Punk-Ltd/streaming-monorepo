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

/** What a test holds or breaks on the node, and what it can read back about the sessions opened to it. */
interface NodeOptions {
  /** The deposit POST waits until its session is disposed, then fails, as a real session's aborted request does. */
  readonly holdPost?: boolean;
  /** The deposit POST fails at once, so the move ends unknown and recovery has something to read. */
  readonly failPost?: boolean;
}

/** A node's Bee API as the direct route's sessions see it: each session its own, counting what is sent through them. */
function beeNode(options: NodeOptions = {}) {
  let posts = 0;
  let sessions = 0;
  let pendingReads = 0;
  const open = new Set<object>();
  const create = () => {
    sessions++;
    let disposed = false;
    let onDispose: (() => void) | undefined;
    const usable = () => {
      if (disposed) throw new Error('the session was disposed');
    };
    const session = {
      async getAddresses() {
        usable();
        return { ethereum: transferContext.nodeAddress };
      },
      async getWallet() {
        usable();
        return {
          chainID: 100,
          walletAddress: transferContext.nodeAddress,
          chequebookContractAddress: transferContext.chequebookAddress,
          bzzBalance: '10000000000000000',
          nativeTokenBalance: '1',
        };
      },
      async getChequebookAddress() {
        usable();
        return { chequebookAddress: transferContext.chequebookAddress };
      },
      async getChequebookBalance() {
        usable();
        return { totalBalance: '10000000000000000', availableBalance: '10000000000000000' };
      },
      async depositChequebook() {
        usable();
        posts++;
        if (options.failPost) throw new Error('the answer was lost');
        if (options.holdPost) {
          await new Promise<void>((resolve) => {
            onDispose = resolve;
          });
          throw new Error('the request was aborted');
        }
        return { transactionHash: `0x${'cd'.repeat(32)}` };
      },
      async withdrawChequebook() {
        usable();
        posts++;
        return { transactionHash: `0x${'cd'.repeat(32)}` };
      },
      async getPendingTransactions() {
        usable();
        pendingReads++;
        return { pendingTransactions: [] };
      },
      assertUsable() {
        usable();
      },
      dispose() {
        disposed = true;
        open.delete(session);
        onDispose?.();
      },
    };
    open.add(session);
    return session;
  };
  return { create, counts: () => ({ posts, sessions, pendingReads, open: open.size }) };
}

/** Lets the event loop turn, so a held step can be reached. */
const pause = () => new Promise((resolve) => setImmediate(resolve));

function directService(t: TestContext, host = deployment.host, options: NodeOptions & { holdResolve?: boolean } = {}) {
  const pool = new pg.Pool({ connectionString: 'postgres://unused' });
  t.after(() => pool.end());
  const node = beeNode(options);
  const urls: string[] = [];
  const repository = new InMemoryChequebookOperations();
  let resolving = false;
  let release: (() => void) | undefined;
  // The runtime index.ts passes: no Docker setting at all.
  const service = createChequebookOperationsService(
    pool,
    { rpcEndpoints: '{"100":"https://rpc.example.invalid"}' },
    {
      repository,
      profiles: {
        findByName: async () => {
          resolving = true;
          if (options.holdResolve)
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          return { ...deployment, host };
        },
      },
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
        return node.create();
      },
      connectUnix: () => assert.fail('the direct route opens no Docker connection'),
      preparation: { timeoutMs: 3000 },
    },
  );
  t.after(() => service.shutdown());
  return {
    service,
    urls,
    posts: () => node.counts().posts,
    counts: node.counts,
    repository,
    resolving: () => resolving,
    releaseResolve: () => release?.(),
  };
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

/**
 * Shutdown on the direct route, as the Docker route's transports gave it: every session open to a node is disposed
 * before shutdown resolves, which aborts a POST in flight, and no session is opened after it, so a move that was
 * waiting to be prepared or to claim its dispatch sends nothing.
 */
describe('the direct route at shutdown', { timeout: 10_000 }, () => {
  it('disposes a held POST, and refuses every later move without opening a session', async (t) => {
    const d = directService(t, deployment.host, { holdPost: true });
    const submitting = d.service.submit(transferIntent());
    while (d.posts() === 0) await pause();
    assert.deepEqual(await d.service.shutdown(), []);
    const result = await submitting;
    assert.equal(result.operation.state, 'unknown');
    assert.equal(d.posts(), 1);
    assert.equal(d.counts().open, 0, 'no session is left open');
    await assert.rejects(d.service.submit(transferIntent()));
    assert.equal(d.counts().sessions, 1, 'no session is opened after shutdown');
  });

  it('refuses the session a move waiting on its target would open, so nothing is saved or sent', async (t) => {
    const d = directService(t, deployment.host, { holdResolve: true });
    const submitting = d.service.submit(transferIntent());
    const refused = assert.rejects(submitting);
    while (!d.resolving()) await pause();
    assert.deepEqual(await d.service.shutdown(), []);
    d.releaseResolve();
    await refused;
    assert.equal(d.counts().sessions, 0);
    assert.equal(d.repository.rows.size, 0);
  });

  it('cannot revive a disposed session for its POST when the dispatch claim was held across shutdown', async (t) => {
    const d = directService(t);
    let release!: () => void;
    let claiming = false;
    const claim = d.repository.claimDispatch.bind(d.repository);
    d.repository.claimDispatch = async (id) => {
      claiming = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return claim(id);
    };
    const submitting = d.service.submit(transferIntent());
    while (!claiming) await pause();
    assert.deepEqual(await d.service.shutdown(), []);
    release();
    const result = await submitting;
    assert.equal(result.operation.state, 'unknown');
    assert.equal(d.posts(), 0);
    assert.equal(d.counts().open, 0);
  });

  it("opens no session for recovery's pending read after shutdown", async (t) => {
    const d = directService(t, deployment.host, { failPost: true });
    const { operation } = await d.service.submit(transferIntent());
    assert.equal(operation.state, 'unknown');
    const before = d.counts();
    await d.service.check(operation.id);
    assert.ok(d.counts().pendingReads > before.pendingReads, 'recovery reads the pending list through a session');
    assert.equal(d.counts().open, 0);
    await d.service.shutdown();
    const sessions = d.counts().sessions;
    await d.service.check(operation.id).catch(() => undefined);
    assert.equal(d.counts().sessions, sessions, 'no session is opened after shutdown');
  });
});
