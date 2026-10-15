/**
 * The production money composition with only its outsides replaced.
 *
 * A disposable PostgreSQL schema, a synthetic Bee node reached through the
 * direct route's session seam, and a scripted chain. Everything between them is
 * what the manager runs: the real repository, the real deployments and
 * containers the direct route works a node's Bee API address out of, the real
 * preparation, the real receipt poller and recovery, and the real router behind
 * the real session gate. Nothing here opens a Docker connection or a socket to
 * Bee. Two callers share it, the connected SQL suite and the forked server the
 * connected browser suite drives.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import express, { type Express, type RequestHandler } from 'express';
import pg, { type Pool } from 'pg';
import type { BeeTransaction, ChequebookBalance } from '@streaming-infra-manager/common';
import type { BeeAddresses, BeeChequebookAddress, BeeWallet } from '../../src/domain/BeeClient.js';
import type { ChequebookChainReader } from '../../src/domain/chequebook/ChequebookChainRegistry.js';
import type {
  ChequebookRuntime,
  ChequebookServiceDependencies,
} from '../../src/domain/chequebook/createChequebookOperationsService.js';
import type { ChequebookOperationsService } from '../../src/domain/chequebook/ChequebookOperationsService.js';
import type { BeeTransferSession } from '../../src/domain/chequebook/PinnedBeeSession.js';
import { ContainerRepository } from '../../src/domain/ContainerRepository.js';
import { buildContainerSnapshot } from '../../src/domain/containerKeysSpec.js';
import { BeeConnectionError } from '../../src/domain/errors/BeeConnectionError.js';
import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { createAuthRouter } from '../../src/api/routes/auth.js';
import { createChequebookRouter } from '../../src/api/routes/chequebook.js';
import { createRequireSession } from '../../src/api/middleware/requireSession.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { AuthService } from '../../src/domain/auth/AuthService.js';
import { OpenStreams } from '../../src/domain/auth/OpenStreams.js';
import type { ChequebookService } from '../../src/domain/ChequebookService.js';
import { InMemoryCredentialRepository } from './InMemoryCredentialRepository.js';
import { InMemorySessionRepository } from './InMemorySessionRepository.js';
import { InMemoryUserRepository } from './InMemoryUserRepository.js';
import { instanceForProfile, transactionHash, transferContext } from './chequebookOperations.js';
import { seedSyntheticChequebookTarget, SyntheticTargetChequebookRepository } from './syntheticChequebookTargets.js';
import { PLACEHOLDER_DATABASE_URL } from '../unit/run.mjs';

export const CONNECTED_PROFILE = 'test-deployment';
/** The port the synthetic Bee container records, which the SQL reservation has to agree with. */
const PUBLISHED_BEE_PORT = 11633;
export const CONNECTED_OPERATOR = 'connected-operator';
/** A synthetic password for a synthetic in-memory user. It opens nothing outside this process. */
export const CONNECTED_OPERATOR_PASSWORD = 'a-long-enough-synthetic-password';
const START_BLOCK = 500n;
const RECEIPT_BLOCK = 501n;
const CHAIN_TOKEN = '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';

export type ReceiptAnswer = 'pending' | 'success' | 'reverted';
const hashAt = (block: bigint) =>
  block === START_BLOCK ? transferContext.startBlockHash : `0x${block.toString(16).padStart(64, '0')}`;

export interface SyntheticChain {
  readonly reader: ChequebookChainReader;
  receiptReads(): number;
  answers(next: ReceiptAnswer): void;
  outage(on: boolean): void;
  /** Whether the receipt's block is final yet. It is unless a case says otherwise. */
  final(on: boolean): void;
}

/** One chain, scripted, so a case can say what changed rather than what the chain happened to do. */
export function syntheticChain(): SyntheticChain {
  let answer: ReceiptAnswer = 'pending';
  let available = true;
  let final = true;
  let receiptReads = 0;
  const unavailable = (): never => {
    throw new Error('synthetic-rpc-outage');
  };
  const reader: ChequebookChainReader = {
    async chainId() {
      return available ? 100 : unavailable();
    },
    async transactionCount() {
      return available ? '8' : unavailable();
    },
    async blockTransactions() {
      return available ? null : unavailable();
    },
    async blockHeader(block) {
      if (!available) unavailable();
      const head = answer === 'pending' ? START_BLOCK : RECEIPT_BLOCK;
      const number = block === 'latest' ? head : block === 'finalized' ? (final ? head : START_BLOCK) : block;
      return { number: String(number), hash: hashAt(number), parentHash: hashAt(number - 1n) };
    },
    async transaction(hash) {
      if (!available) unavailable();
      if (answer === 'pending') return null;
      return {
        hash,
        chainId: 100,
        from: transferContext.nodeAddress,
        to: CHAIN_TOKEN,
        data: `0xa9059cbb${transferContext.chequebookAddress.slice(2).padStart(64, '0')}${5000000000000000n.toString(16).padStart(64, '0')}`,
        nonce: '9',
        value: '0',
        blockNumber: String(RECEIPT_BLOCK),
        blockHash: hashAt(RECEIPT_BLOCK),
      };
    },
    async receipt(hash) {
      receiptReads++;
      if (!available) unavailable();
      if (answer === 'pending') return null;
      return {
        transactionHash: hash,
        from: transferContext.nodeAddress,
        to: CHAIN_TOKEN,
        blockNumber: String(RECEIPT_BLOCK),
        blockHash: hashAt(RECEIPT_BLOCK),
        status: answer === 'success' ? 'success' : 'reverted',
      };
    },
  };
  return {
    reader,
    receiptReads: () => receiptReads,
    answers(next) {
      answer = next;
    },
    outage(on) {
      available = !on;
    },
    final(on) {
      final = on;
    },
  };
}

/** One request the synthetic Bee answered or refused, in the order it came. */
export interface SyntheticBeeRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
}

/** What the direct route's session seam takes: the transfer session and the pending-transactions read recovery makes. */
export type SyntheticBeeSession = BeeTransferSession & { getPendingTransactions(): Promise<unknown> };

export interface SyntheticBeeNode {
  /** The factory's `createSession` seam, which a real manager fills with a plain HTTP session to the node's Bee API. */
  readonly createSession: (url: string) => SyntheticBeeSession;
  /** Every Bee API address a session was opened for. */
  sessionUrls(): readonly string[];
  requests(): readonly SyntheticBeeRequest[];
  posts(): number;
  /** The next transfer reaches Bee, which sends it, and its answer is lost on the way back. */
  dropNextResponse(): void;
}

/**
 * A Bee node as the direct route reaches it, answering what a funded node answers. Each session takes one transfer and
 * no read after it, and is unusable once disposed, as a real one is. A transfer whose answer was lost was still sent:
 * from then on the node lists its hash as pending, which is what recovery finds it by.
 */
export function syntheticBeeNode(options: { dropNextResponse?: boolean } = {}): SyntheticBeeNode {
  const sessionUrls: string[] = [];
  const requests: SyntheticBeeRequest[] = [];
  const pending: string[] = [];
  let dropResponse = options.dropNextResponse === true;
  const createSession = (url: string): SyntheticBeeSession => {
    sessionUrls.push(url);
    let disposed = false;
    let posted = false;
    const read = async <T>(path: string, answer: T): Promise<T> => {
      requests.push({ method: 'GET', url: path });
      if (disposed || posted) throw new BeeConnectionError();
      return structuredClone(answer);
    };
    const send = async (direction: 'deposit' | 'withdraw', amount: bigint): Promise<BeeTransaction> => {
      requests.push({ method: 'POST', url: `/chequebook/${direction}?amount=${amount}` });
      if (disposed || posted) throw new BeeConnectionError();
      posted = true;
      if (dropResponse) {
        dropResponse = false;
        pending.push(transactionHash);
        disposed = true;
        throw new BeeConnectionError();
      }
      return { transactionHash };
    };
    return {
      getAddresses: () => read<BeeAddresses>('/addresses', { ethereum: transferContext.nodeAddress } as BeeAddresses),
      getWallet: () =>
        read<BeeWallet>('/wallet', {
          chainID: 100,
          walletAddress: transferContext.nodeAddress,
          chequebookContractAddress: transferContext.chequebookAddress,
          bzzBalance: '10000000000000000',
          nativeTokenBalance: '1',
        } as BeeWallet),
      getChequebookAddress: () =>
        read<BeeChequebookAddress>('/chequebook/address', {
          chequebookAddress: transferContext.chequebookAddress,
        } as BeeChequebookAddress),
      getChequebookBalance: () =>
        read<ChequebookBalance>('/chequebook/balance', {
          totalBalance: '10000000000000000',
          availableBalance: '10000000000000000',
        } as ChequebookBalance),
      getPendingTransactions: () =>
        read('/transactions', { pendingTransactions: pending.map((hash) => ({ transactionHash: hash })) }),
      depositChequebook: (amount) => send('deposit', amount),
      withdrawChequebook: (amount) => send('withdraw', amount),
      assertUsable() {
        if (disposed) throw new BeeConnectionError();
      },
      dispose() {
        disposed = true;
      },
    };
  };
  return {
    createSession,
    sessionUrls: () => sessionUrls,
    requests: () => requests,
    posts: () => requests.filter((request) => request.method === 'POST').length,
    dropNextResponse() {
      dropResponse = true;
    },
  };
}

/** Where the manager's own settings send a transfer's chain reads. */
export const CONNECTED_CHAIN_ENDPOINT = 'https://rpc.example.invalid';
export const CONNECTED_DEFAULT_CHAIN_ENDPOINT = 'https://funding.example.invalid';

export interface ConnectedChequebookOptions {
  readonly pgPort: number;
  readonly database?: string;
  readonly dropNextResponse?: boolean;
  readonly receiptPollBudgetMs?: number;
  readonly pollIntervalMs?: number;
  /**
   * The manager's chain settings: CHEQUEBOOK_RPC_ENDPOINTS naming the chain (the default), only the manager's default
   * endpoint, FUNDING_RPC_URL or BEE_RPC_ENDPOINT, or neither.
   */
  readonly chainSettings?: 'configured' | 'default' | 'none';
}

export interface ConnectedChequebookBackend {
  readonly pool: Pool;
  readonly repository: SyntheticTargetChequebookRepository;
  readonly service: ChequebookOperationsService;
  readonly chain: SyntheticChain;
  readonly bee: SyntheticBeeNode;
  readonly schema: string;
  /** The runtime this backend's service was built with, for a second manager on the same fixture. */
  readonly runtime: ChequebookRuntime;
  /** The direct route's seams this backend's service was built with, for a second manager on the same fixture. */
  readonly directRoute: Required<Pick<ChequebookServiceDependencies, 'profiles' | 'containers' | 'createSession'>>;
  /** Every endpoint a chain reader was created for. */
  chainEndpoints(): readonly string[];
  pollerLines(): readonly string[];
  beePosts(): number;
  beeRequests(): readonly SyntheticBeeRequest[];
  dropNextResponse(): void;
  close(): Promise<void>;
}

export async function startConnectedChequebook(
  options: ConnectedChequebookOptions,
): Promise<ConnectedChequebookBackend> {
  // The service factory reaches src/utils/config.ts, through the direct route's resolver and localHost.ts, and
  // config.ts refuses to load without DATABASE_URL. The connected suites set only CHEQUEBOOK_TEST_PG_PORT, so the
  // factory is loaded here, after the same placeholder test/unit/run.mjs gives the unit suite for the same reason
  // (PLACEHOLDER_DATABASE_URL). Nothing connects with it: the journal pool below is built from the test port alone,
  // and a URL already set is kept.
  process.env.DATABASE_URL ??= PLACEHOLDER_DATABASE_URL;
  const { createChequebookOperationsService } =
    await import('../../src/domain/chequebook/createChequebookOperationsService.js');
  const connection = {
    host: '127.0.0.1',
    port: options.pgPort,
    user: 'postgres',
    database: options.database ?? 'chequebook_test',
    connectionTimeoutMillis: 30000,
  };
  const schema = `connected_chequebook_${randomBytes(8).toString('hex')}`;
  // Registered as each resource appears, so a start that fails partway removes exactly what it made.
  const teardown: (() => Promise<void>)[] = [];
  const unwind = async (): Promise<unknown[]> => {
    const failures: unknown[] = [];
    for (const step of [...teardown].reverse()) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  };
  try {
    const admin = new pg.Pool(connection);
    teardown.push(() => admin.end());
    await admin.query(`CREATE SCHEMA ${schema}`);
    teardown.push(async () => {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    });
    const pool = new pg.Pool({ ...connection, max: 20, options: `-c search_path=${schema}` });
    teardown.push(() => pool.end());
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    await pool.query('INSERT INTO profiles (name, port_slot, instance_id, stack_version_id) VALUES ($1, 1, $2, 1)', [
      CONNECTED_PROFILE,
      instanceForProfile(CONNECTED_PROFILE),
    ]);
    await seedSyntheticChequebookTarget(pool, CONNECTED_PROFILE);
    await pool.query('UPDATE port_reservations SET port = $2 WHERE profile_name = $1', [
      CONNECTED_PROFILE,
      PUBLISHED_BEE_PORT,
    ]);
    // The node's Bee container as the deploy recorded it: the port the direct route reaches its Bee API on, the one
    // the reservation owns.
    const containers = new ContainerRepository(pool);
    await containers.upsert(
      CONNECTED_PROFILE,
      buildContainerSnapshot('bee-uploader', { BEE_UPLOADER_API_PORT: String(PUBLISHED_BEE_PORT) }),
    );

    const chain = syntheticChain();
    const bee = syntheticBeeNode({ dropNextResponse: options.dropNextResponse });
    const pollerLines: string[] = [];
    const chainEndpoints: string[] = [];
    const repository = new SyntheticTargetChequebookRepository(pool, {
      receiptPollBudgetMs: options.receiptPollBudgetMs,
    });
    const settings = options.chainSettings ?? 'configured';
    // Built as a value and not a literal, so the runtime's retired Docker fields can go without touching this file.
    const runtimeFields = {
      rpcEndpoints: settings === 'configured' ? `{"100":"${CONNECTED_CHAIN_ENDPOINT}"}` : undefined,
      chainEndpoint: settings === 'none' ? undefined : CONNECTED_DEFAULT_CHAIN_ENDPOINT,
      dockerTransports: undefined,
    };
    const runtime: ChequebookRuntime = runtimeFields;
    const directRoute = {
      profiles: new ProfileRepository(pool),
      containers,
      createSession: bee.createSession,
    };
    const service = createChequebookOperationsService(pool, runtime, {
      ...directRoute,
      repository,
      createChainReader: (endpoint) => {
        chainEndpoints.push(endpoint);
        return chain.reader;
      },
      preparation: { timeoutMs: 3000 },
      receiptPolling: {
        intervalMs: options.pollIntervalMs ?? 50,
        log: { info: (line) => pollerLines.push(line), warn: (line) => pollerLines.push(line) },
      },
    });

    let closed = false;
    return {
      pool,
      repository,
      service,
      chain,
      bee,
      schema,
      runtime,
      directRoute,
      chainEndpoints: () => chainEndpoints,
      pollerLines: () => pollerLines,
      beePosts: () => bee.posts(),
      beeRequests: () => bee.requests(),
      dropNextResponse: () => bee.dropNextResponse(),
      async close() {
        if (closed) return;
        closed = true;
        const failures: unknown[] = [];
        try {
          await service.shutdown();
        } catch (error) {
          failures.push(error);
        }
        failures.push(...(await unwind()));
        if (failures.length > 0) throw failures[0];
      },
    };
  } catch (error) {
    await unwind();
    throw error;
  }
}

export interface ConnectedChequebookAuth {
  readonly authService: AuthService;
  readonly users: InMemoryUserRepository;
  readonly requireSession: RequestHandler;
  accountId(): Promise<number>;
}

export async function connectedChequebookAuth(): Promise<ConnectedChequebookAuth> {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const authService = new AuthService(
    users,
    sessions,
    new InMemoryCredentialRepository(users, sessions),
    new OpenStreams(),
  );
  await authService.addUser(CONNECTED_OPERATOR, CONNECTED_OPERATOR_PASSWORD);
  return {
    authService,
    users,
    requireSession: createRequireSession(authService),
    accountId: async () => (await users.findByUsername(CONNECTED_OPERATOR))!.id,
  };
}

export interface ConnectedChequebookApiOptions {
  readonly onRequest?: (method: string, path: string) => void;
  /** Everything the pages need that is not money. Mounted behind the session gate, before the money router. */
  readonly stubs?: RequestHandler;
  readonly chequebookSummary?: ChequebookService;
}

/** The manager's own gate order: same-site, then open auth, then a session, then the money routes. */
export function connectedChequebookApi(
  service: ChequebookOperationsService,
  auth: ConnectedChequebookAuth,
  options: ConnectedChequebookApiOptions = {},
): Express {
  const app = express();
  app.use(requireSameSite, express.json({ limit: '256kb' }));
  if (options.onRequest)
    app.use((req, _res, next) => {
      options.onRequest!(req.method, req.path);
      next();
    });
  app.use('/auth', createAuthRouter(auth.authService, auth.requireSession));
  app.use(auth.requireSession);
  if (options.stubs) app.use(options.stubs);
  app.use(createChequebookRouter(options.chequebookSummary ?? ({} as ChequebookService), service), errorHandler);
  return app;
}

export const connectedRequestId = (): string => randomUUID();
