import type { Pool } from 'pg';
import { ChequebookChainRegistry, type ChequebookChainReader } from './ChequebookChainRegistry.js';
import type { ChequebookOperation } from '@streaming-infra-manager/common';
import {
  ChequebookTransferPreparation,
  ownedAcquisitionBudgets,
  type CaptureTransferTarget,
  type OwnedTransferPreparationOptions,
} from './ChequebookTransferPreparation.js';
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
import { PostgresBeeBridgeQualifications } from './PostgresBeeBridgeQualifications.js';
import type { ChequebookOperationRepository } from './ChequebookOperationRepository.js';
import type { BeeBridgeQualificationRecord } from './beeBridgeQualification.js';
import { ChequebookDockerTransports, localDockerSocketPath } from './ChequebookDockerTransports.js';
import { OwnedChequebookTransports, type ChequebookTransportDependencies } from './OwnedChequebookTransports.js';
import { ConfiguredBeeTargetResolver } from './ConfiguredBeeTargetResolver.js';
import { PinnedBeeSession, type BeeTransferSession } from './PinnedBeeSession.js';
import type { ContainerRepository } from '../ContainerRepository.js';
import type { ProfileRepository } from '../ProfileRepository.js';
import { Logger } from '../Logger.js';

export interface ChequebookServiceDependencies extends ChequebookTransportDependencies {
  readonly repository?: ChequebookOperationRepository;
  readonly captureTarget?: CaptureTransferTarget;
  readonly createChainReader?: (endpoint: string) => ChequebookChainReader;
  readonly qualificationCatalog?: readonly BeeBridgeQualificationRecord[];
  readonly preparation?: OwnedTransferPreparationOptions;
  readonly receiptPolling?: ReceiptPollerOptions;
  /**
   * The deployments and their recorded containers, which the direct route works a node's Bee API address out of.
   * With both given the service reaches every node through its Bee API and opens no Docker connection; without them
   * it takes the Docker route, which Dev-1 removes once the direct route is the only one built.
   */
  readonly profiles?: Pick<ProfileRepository, 'findByName'>;
  readonly containers?: Pick<ContainerRepository, 'listApiContainers'>;
  /**
   * The direct route's session to a node's Bee API, a plain HTTP one unless a test hands in its own: the transfer
   * session, plus the pending-transactions read recovery makes on it.
   */
  readonly createSession?: (url: string) => BeeTransferSession & Pick<PinnedBeeSession, 'getPendingTransactions'>;
}

/** A saved transfer's node, which the chain registry reads again when it does not know that node's endpoint. */
type SavedChainNode = Pick<ChequebookOperation, 'chainId' | 'nodeAddress'> & {
  readonly profileName?: string;
  readonly profileInstanceId?: string | null;
};

/** The manager's own process settings a transfer reads. None of them comes from a request or a profile. */
export interface ChequebookRuntime {
  readonly rpcEndpoints: string | undefined;
  /**
   * The manager's default chain endpoint, FUNDING_RPC_URL or else BEE_RPC_ENDPOINT: where receipts, finality and
   * recovery read the chain for any chain CHEQUEBOOK_RPC_ENDPOINTS does not name. Verified against the node's chain
   * before use.
   */
  readonly chainEndpoint?: string | undefined;
  readonly dockerTransports: string | undefined;
  /** The manager's DOCKER_HOST, which decides the local socket a transfer on localhost uses. */
  readonly dockerHost?: string | undefined;
}

/** Runtime strings override the default routes, never the other way round. Test dependencies are trusted code, never API or profile fields. */
export function createChequebookOperationsService(
  pool: Pool,
  runtime: ChequebookRuntime,
  dependencies: ChequebookServiceDependencies = {},
): ChequebookOperationsService {
  let chainRegistry: ChequebookChainRegistry | undefined;
  const registry = () =>
    (chainRegistry ??= new ChequebookChainRegistry(runtime.rpcEndpoints, dependencies.createChainReader, {
      defaultEndpoint: runtime.chainEndpoint,
    }));
  const ownership = new PostgresChequebookTargetOwnership(pool);
  const captureTarget = dependencies.captureTarget ?? ownership.capture.bind(ownership);
  const direct =
    dependencies.profiles && dependencies.containers
      ? new ConfiguredBeeTargetResolver(dependencies.profiles, dependencies.containers, captureTarget)
      : null;
  const routes = direct
    ? null
    : new ChequebookDockerTransports(runtime.dockerTransports, dependencies.qualificationCatalog, {
        localSocketPath: localDockerSocketPath(runtime.dockerHost),
      });
  const transports = routes
    ? new OwnedChequebookTransports(routes, {
        ...dependencies,
        bridgeQualifications: dependencies.bridgeQualifications ?? new PostgresBeeBridgeQualifications(pool),
      })
    : null;
  const acquire = transports ? transports.acquire.bind(transports) : null;
  const budgets = ownedAcquisitionBudgets(structuredClone(dependencies.preparation ?? {}));
  /**
   * Opens the node's owned connection only to read the endpoint its container runs with. The bridge it opens is
   * closed unused. The direct route reads no node for an endpoint: the manager's own settings name it.
   */
  const readNodeEndpoint = (node: SavedChainNode) => async (signal?: AbortSignal) => {
    if (!acquire || !node.profileName || !node.profileInstanceId) return null;
    const acquired = await acquire(
      await captureTarget(node.profileName, node.profileInstanceId),
      budgets,
      signal ?? new AbortController().signal,
    );
    acquired.stream.destroy();
    return acquired.chainEndpoint;
  };
  const chains = {
    forPreparedNode: (chainId: number, nodeAddress: string, nodeEndpoint: string | null, signal?: AbortSignal) =>
      registry().forPreparedNode(chainId, nodeAddress, nodeEndpoint, signal),
    forSavedNode: (node: SavedChainNode, signal?: AbortSignal) =>
      registry().forSavedNode(node.chainId, node.nodeAddress, readNodeEndpoint(node), signal),
  };
  const createSession = dependencies.createSession ?? ((url: string) => new PinnedBeeSession(url));
  // The real session serves both readers; the type above says a test's must too.
  const preparation = direct
    ? new ChequebookTransferPreparation(direct.resolve.bind(direct), chains, createSession, {
        timeoutMs: dependencies.preparation?.timeoutMs,
      })
    : ChequebookTransferPreparation.fromOwnedTarget(captureTarget, acquire!, chains, dependencies.preparation);
  const pending = direct
    ? new ChequebookPendingHashes(direct.resolve.bind(direct), createSession)
    : ChequebookPendingHashes.fromOwnedTarget(captureTarget, acquire!, dependencies.preparation);
  const repository = dependencies.repository ?? new PostgresChequebookOperationRepository(pool);
  const receiptInspector = new ChequebookReceiptInspector((operation, signal) =>
    chains.forSavedNode(operation, signal),
  );
  const receipts = new ChequebookReceiptCheck(repository, receiptInspector.inspect.bind(receiptInspector));
  const recoveryInspector = new ChequebookRecoveryInspector(
    (operation, signal) => chains.forSavedNode(operation, signal),
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
    transports ? transports.shutdown.bind(transports) : async () => [],
    poller,
  );
}
