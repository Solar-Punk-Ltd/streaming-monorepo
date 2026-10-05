import {
  BEE_GATEWAY_SERVICE,
  BEE_UPLOADER_SERVICE,
  getErrorMessage,
  LIGHT_NODE_MODE,
  gatewayNodeMode,
  isStageKind,
  ownsBeeNode,
  parseBeePublishers,
  rungOrder,
} from '@streaming-infra-manager/common';
import {
  type FundingInventory,
  type FundingNode,
  type FundingNodeRole,
  fundingInventorySchema,
} from '@streaming-monorepo/contracts';

import type { Profile } from '../../types/index.js';
import type { BeeWallet } from '../BeeClient.js';
import { tokenAddressForChain } from '../chequebook/transactionIdentity.js';
import { Logger } from '../Logger.js';
import { readFailureFrom } from '../nodeReadFailure.js';
import { type CatalogueDesignationRow, isDesignated } from '../stages/CatalogueDesignationRepository.js';

const logger = Logger.getInstance();

/**
 * The chain the funding API answers for: Gnosis Chain, the chain the stack's Bee nodes run on, whose BZZ token's
 * address is the one the manager's chequebook checks already pin (`tokenAddressForChain` in
 * `chequebook/transactionIdentity.ts`). A node that reports another chain is answered with no wallet, so nothing is
 * sent to it for this chain.
 */
export const FUNDING_CHAIN_ID = 100;
export const FUNDING_BZZ_TOKEN = tokenAddressForChain(FUNDING_CHAIN_ID) as string;

/** What one wallet read came to, with no node address in it. */
type WalletReading =
  | { ok: true; walletAddress: string; xdaiWei: string; xbzzPlur: string }
  | { ok: false; readError: string };

/** One node to read: the inventory's own fields, and how to reach it, which never leaves this service. */
interface PlannedNode {
  nodeId: string;
  label: string;
  role: FundingNodeRole;
  apiUrl: () => Promise<string>;
}

export interface FundingInventoryDeps {
  profiles: { list(): Promise<Profile[]> };
  /** The catalogue designation, whose deployment in force is the catalogue node. */
  catalogue: { read(): Promise<CatalogueDesignationRow> };
  /** The Bee API of a deployment's own `bee-uploader`, as the manager reaches it, `beeApiUrlFor`. */
  uploaderApiUrl(profile: Profile): string;
  /** The Bee API of a deployment's `bee-gateway`, from the port its next deploy gives it. */
  gatewayApiUrl(profile: Profile): Promise<string>;
  /** `GET /wallet` on the Bee API at this address, `BeeClient.getWallet()`. */
  wallet(apiUrl: string): Promise<BeeWallet>;
  now?: () => Date;
}

/** A batch id as a stamp id records it, without `0x` and in lower case, as the stage records compare them. */
function batchIdOf(stampId: string): string {
  return stampId.replace(/^0x/i, '').toLowerCase();
}

const DIGITS = /^\d+$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Why a wallet read failed, in a sentence with no address in it. */
function readErrorOf(error: unknown): string {
  switch (readFailureFrom(error, 0).reason) {
    case 'timeout':
      return 'The node did not answer in time.';
    case 'refused':
      return 'The node refused to say what its wallet holds.';
    case 'malformed':
      return 'The node answered something that is not a wallet.';
    default:
      return 'The node could not be reached.';
  }
}

/**
 * Why a node's address could not be worked out here, before it was asked anything: for a gateway, the port its next
 * deploy gives it, which `nextEnvFor` refuses while the deployment's stack version is not ready to deploy from.
 */
function addressErrorOf(role: FundingNodeRole): string {
  return role === 'gateway'
    ? 'The gateway’s address could not be worked out on this manager.'
    : 'The node’s address could not be worked out on this manager.';
}

/** A node's `/wallet` answer as the inventory takes it, or why it does not. */
function readingOf(wallet: BeeWallet): WalletReading {
  if (wallet.chainID !== undefined && wallet.chainID !== FUNDING_CHAIN_ID) {
    return { ok: false, readError: `The node runs on chain ${wallet.chainID}, not Gnosis Chain.` };
  }
  if (!wallet.walletAddress || !ADDRESS.test(wallet.walletAddress)) {
    return { ok: false, readError: 'The node reported no wallet address.' };
  }
  if (!DIGITS.test(wallet.nativeTokenBalance ?? '') || !DIGITS.test(wallet.bzzBalance ?? '')) {
    return { ok: false, readError: 'The node reported balances that are not whole numbers.' };
  }
  return {
    ok: true,
    walletAddress: wallet.walletAddress.toLowerCase(),
    // Bee prints a balance with no leading zeros, but nothing else may reach the contract's pattern.
    xdaiWei: BigInt(wallet.nativeTokenBalance).toString(),
    xbzzPlur: BigInt(wallet.bzzBalance).toString(),
  };
}

/**
 * `GET /api/admin-funding/inventory`: every stage's nodes and the brand's catalogue node, each with its wallet as the
 * node reports it now, or the reason it could not be read.
 *
 * A stage is a deployment that runs a stream uploader. Its nodes are its own `bee-uploader`, its `bee-gateway` when
 * that runs light (an ultra-light gateway is on no chain and has no wallet), and the rungs of its ABR pool, lowest
 * first, each the deployment of this manager that stamps with that rung's batch, as the stage records find them. A
 * rung whose node this manager does not run is left out, since nothing could be sent to it through this manager.
 *
 * A node is named by an opaque id, `<instance_id>:<service>`, and a label. Its Bee API address, its host, the chain
 * endpoint it reads and any key stay inside this service, and every answer passes the contract's schema before it
 * leaves, so a field nobody meant to send is dropped there as well.
 */
export class FundingInventoryService {
  private readonly now: () => Date;

  constructor(private readonly deps: FundingInventoryDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async inventory(): Promise<FundingInventory> {
    const observedAt = this.now().toISOString();
    const profiles = (await this.deps.profiles.list()).filter((profile) => profile.status !== 'REMOVING');
    const reads = new Map<string, Promise<WalletReading>>();
    const read = (planned: PlannedNode) => this.nodeOf(planned, reads);

    const stages = await Promise.all(
      profiles
        .filter((profile) => isStageKind(profile.kind))
        .map(async (stage) => ({
          stageId: stage.instance_id,
          name: stage.name,
          nodes: await Promise.all(this.nodesOf(stage, profiles).map(read)),
        })),
    );
    const catalogueNode = await this.catalogueNodeOf(profiles);

    const answer: FundingInventory = {
      observedAt,
      chain: { chainId: FUNDING_CHAIN_ID, bzzToken: FUNDING_BZZ_TOKEN },
      stages,
      catalogue: catalogueNode ? await read(catalogueNode) : null,
    };
    return fundingInventorySchema.parse(answer);
  }

  /** A stage's nodes, before any is read. */
  private nodesOf(stage: Profile, profiles: readonly Profile[]): PlannedNode[] {
    const nodes: PlannedNode[] = [];
    if (ownsBeeNode(stage)) {
      nodes.push({
        nodeId: `${stage.instance_id}:${BEE_UPLOADER_SERVICE}`,
        label: `${stage.name} Bee node`,
        role: 'uploader',
        apiUrl: async () => this.deps.uploaderApiUrl(stage),
      });
    }
    if (gatewayNodeMode(stage) === LIGHT_NODE_MODE) {
      nodes.push({
        nodeId: `${stage.instance_id}:${BEE_GATEWAY_SERVICE}`,
        label: `${stage.name} gateway`,
        role: 'gateway',
        apiUrl: () => this.deps.gatewayApiUrl(stage),
      });
    }
    const entries = stage.bee_publishers ? (parseBeePublishers(stage.bee_publishers) ?? []) : [];
    const stamping = profiles.filter((candidate) => ownsBeeNode(candidate) && candidate.stamp_id);
    for (const entry of [...entries].sort((a, b) => rungOrder(a.rung) - rungOrder(b.rung))) {
      const node = stamping.find((candidate) => batchIdOf(candidate.stamp_id ?? '') === entry.batchId.toLowerCase());
      if (!node) continue;
      nodes.push({
        nodeId: `${node.instance_id}:${BEE_UPLOADER_SERVICE}`,
        label: `${stage.name} ${entry.rung} rung, ${node.name}`,
        role: 'rung',
        apiUrl: async () => this.deps.uploaderApiUrl(node),
      });
    }
    return nodes;
  }

  /** The catalogue node, when a designation is in force and its deployment is still here. */
  private async catalogueNodeOf(profiles: readonly Profile[]): Promise<PlannedNode | null> {
    const row = await this.deps.catalogue.read();
    if (!isDesignated(row)) return null;
    const node = profiles.find((profile) => profile.name === row.profileName);
    if (!node) return null;
    return {
      nodeId: `${node.instance_id}:${BEE_UPLOADER_SERVICE}`,
      label: `${node.name} catalogue node`,
      role: 'uploader',
      apiUrl: async () => this.deps.uploaderApiUrl(node),
    };
  }

  /** One node with its wallet, each node read once however many stages name it. */
  private async nodeOf(planned: PlannedNode, reads: Map<string, Promise<WalletReading>>): Promise<FundingNode> {
    let apiUrl: string;
    try {
      apiUrl = await planned.apiUrl();
    } catch (err) {
      logger.debug(`[Funding] could not work out the address of ${planned.label}: ${getErrorMessage(err)}`);
      return this.unread(planned, addressErrorOf(planned.role));
    }
    let reading: WalletReading;
    try {
      let pending = reads.get(apiUrl);
      if (!pending) {
        pending = this.deps.wallet(apiUrl).then(readingOf, (err: unknown) => {
          logger.debug(`[Funding] could not read the wallet of ${planned.label}: ${readErrorOf(err)}`);
          return { ok: false, readError: readErrorOf(err) } as const;
        });
        reads.set(apiUrl, pending);
      }
      reading = await pending;
    } catch (err) {
      reading = { ok: false, readError: readErrorOf(err) };
    }
    if (!reading.ok) return this.unread(planned, reading.readError);
    const { nodeId, label, role } = planned;
    return { nodeId, label, role, ...pick(reading), readError: null };
  }

  /** A node answered with no wallet, and why in a sentence. */
  private unread({ nodeId, label, role }: PlannedNode, readError: string): FundingNode {
    return { nodeId, label, role, walletAddress: null, xdaiWei: null, xbzzPlur: null, readError };
  }
}

function pick(reading: Extract<WalletReading, { ok: true }>) {
  return { walletAddress: reading.walletAddress, xdaiWei: reading.xdaiWei, xbzzPlur: reading.xbzzPlur };
}
