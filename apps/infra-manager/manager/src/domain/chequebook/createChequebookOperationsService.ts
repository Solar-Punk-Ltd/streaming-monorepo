import type { Pool } from 'pg';
import { ChequebookChainRegistry, type ChequebookChainReader } from './ChequebookChainRegistry.js';
import { ChequebookTransferPreparation, type CaptureTransferTarget } from './ChequebookTransferPreparation.js';
import { ChequebookPendingHashes } from './ChequebookPendingHashes.js';
import { ChequebookReceiptInspector } from './ChequebookReceiptInspector.js';
import { ChequebookReceiptCheck } from './ChequebookReceiptCheck.js';
import { ChequebookRecoveryInspector } from './ChequebookRecoveryInspector.js';
import { ChequebookRecovery } from './ChequebookRecovery.js';
import { ChequebookSubmission } from './ChequebookSubmission.js';
import { ChequebookOperationsService } from './ChequebookOperationsService.js';
import { ChequebookReceiptPoller, type ReceiptPollerOptions } from './ChequebookReceiptPoller.js';
import { PostgresChequebookOperationRepository } from './PostgresChequebookOperationRepository.js';
import { PostgresChequebookTargetOwnership } from './PostgresChequebookTargetOwnership.js';
import type { ChequebookOperationRepository } from './ChequebookOperationRepository.js';
import { ChequebookPreparationError } from '../errors/ChequebookPreparationError.js';
import { ConfiguredBeeTargetResolver } from './ConfiguredBeeTargetResolver.js';
import { PinnedBeeSession, type BeeTransferSession } from './PinnedBeeSession.js';
import type { ContainerRepository } from '../ContainerRepository.js';
import type { ProfileRepository } from '../ProfileRepository.js';
import { Logger } from '../Logger.js';

export interface ChequebookServiceDependencies {
  /** The deployments and their recorded containers, which a node's Bee API address is worked out of. */
  readonly profiles: Pick<ProfileRepository, 'findByName'>;
  readonly containers: Pick<ContainerRepository, 'listApiContainers'>;
  readonly repository?: ChequebookOperationRepository;
  readonly captureTarget?: CaptureTransferTarget;
  readonly createChainReader?: (endpoint: string) => ChequebookChainReader;
  readonly preparation?: { readonly timeoutMs?: number };
  readonly receiptPolling?: ReceiptPollerOptions;
  /**
   * The session to a node's Bee API, a plain HTTP one unless a test hands in its own: the transfer session, plus the
   * pending-transactions read recovery makes on it.
   */
  readonly createSession?: (url: string) => DirectSession;
}

/** The manager's own process settings a transfer reads. None of them comes from a request or a profile. */
export interface ChequebookRuntime {
  readonly rpcEndpoints: string | undefined;
  /**
   * The manager's default chain endpoint, FUNDING_RPC_URL or else BEE_RPC_ENDPOINT: where preparation, receipts,
   * finality and recovery read the chain for any chain CHEQUEBOOK_RPC_ENDPOINTS does not name. Verified against the
   * node's chain before use.
   */
  readonly chainEndpoint?: string | undefined;
}

/** Runtime strings override the default routes, never the other way round. Test dependencies are trusted code, never API or profile fields. */
export function createChequebookOperationsService(
  pool: Pool,
  runtime: ChequebookRuntime,
  dependencies: ChequebookServiceDependencies,
): ChequebookOperationsService {
  let chainRegistry: ChequebookChainRegistry | undefined;
  const registry = () =>
    (chainRegistry ??= new ChequebookChainRegistry(runtime.rpcEndpoints, dependencies.createChainReader, {
      defaultEndpoint: runtime.chainEndpoint,
    }));
  const forChain = (chainId: number, signal?: AbortSignal) => registry().forChain(chainId, signal);
  const ownership = new PostgresChequebookTargetOwnership(pool);
  const captureTarget = dependencies.captureTarget ?? ownership.capture.bind(ownership);
  const resolver = new ConfiguredBeeTargetResolver(dependencies.profiles, dependencies.containers, captureTarget);
  const resolve = resolver.resolve.bind(resolver);
  const sessions = ownedDirectSessions(dependencies.createSession ?? ((url: string) => new PinnedBeeSession(url)));
  const preparation = new ChequebookTransferPreparation(resolve, { forChain }, sessions.create, {
    timeoutMs: dependencies.preparation?.timeoutMs,
  });
  const pending = new ChequebookPendingHashes(resolve, sessions.create);
  const repository = dependencies.repository ?? new PostgresChequebookOperationRepository(pool);
  const receiptInspector = new ChequebookReceiptInspector((operation, signal) => forChain(operation.chainId, signal));
  const receipts = new ChequebookReceiptCheck(repository, receiptInspector.inspect.bind(receiptInspector));
  const recoveryInspector = new ChequebookRecoveryInspector(
    (operation, signal) => forChain(operation.chainId, signal),
    pending.read.bind(pending),
  );
  const poller = new ChequebookReceiptPoller(
    { listAwaitingReceipt: repository.listAwaitingReceipt.bind(repository) },
    { check: receipts.check.bind(receipts) },
    { log: Logger.getInstance(), ...dependencies.receiptPolling },
  );
  return new ChequebookOperationsService(
    repository,
    new ChequebookSubmission(repository, preparation.prepare.bind(preparation)),
    receipts,
    new ChequebookRecovery(repository, recoveryInspector, receipts),
    sessions.shutdown,
    poller,
  );
}

/** A session to a node's Bee API: the transfer session plus the pending read recovery makes. */
type DirectSession = BeeTransferSession & Pick<PinnedBeeSession, 'getPendingTransactions'>;

/**
 * The sessions to nodes. Each is tracked while open. Shutdown disposes every one before it resolves, which aborts a
 * POST in flight and leaves a prepared move unable to send, and from then on no session is opened, so a move still
 * being prepared refuses before anything is saved or sent. The preparation's sessions and recovery's pending reads go
 * through the same owner.
 */
function ownedDirectSessions(open: (url: string) => DirectSession) {
  const live = new Set<DirectSession>();
  let closing = false;
  return {
    create(url: string): DirectSession {
      if (closing) throw new ChequebookPreparationError();
      const session = open(url);
      live.add(session);
      return {
        getAddresses: () => session.getAddresses(),
        getWallet: () => session.getWallet(),
        getChequebookAddress: () => session.getChequebookAddress(),
        getChequebookBalance: () => session.getChequebookBalance(),
        depositChequebook: (amount) => session.depositChequebook(amount),
        withdrawChequebook: (amount) => session.withdrawChequebook(amount),
        getPendingTransactions: () => session.getPendingTransactions(),
        assertUsable: () => session.assertUsable(),
        dispose: () => {
          live.delete(session);
          session.dispose();
        },
      };
    },
    async shutdown(): Promise<void> {
      closing = true;
      for (const session of live) session.dispose();
      live.clear();
    },
  };
}
