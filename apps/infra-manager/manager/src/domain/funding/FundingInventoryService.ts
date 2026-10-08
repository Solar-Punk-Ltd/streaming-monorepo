import {
  BEE_GATEWAY_SERVICE,
  BEE_UPLOADER_SERVICE,
  BLOCK_TIME_SECONDS,
  fullestBucketFillRatio,
  getErrorMessage,
  LIGHT_NODE_MODE,
  MINIMUM_STAMP_VALIDITY_SECONDS,
  gatewayNodeMode,
  isStageKind,
  ownsBeeNode,
  parseBeePublishers,
  rungOrder,
} from '@streaming-infra-manager/common';
import {
  type FundingBatch,
  type FundingInventory,
  type FundingNode,
  type FundingNodeRole,
  type FundingPostage,
  fundingInventorySchema,
} from '@streaming-monorepo/contracts';

import type { Profile } from '../../types/index.js';
import type { BeeChainState, BeeStamp, BeeWallet } from '../BeeClient.js';
import { tokenAddressForChain } from '../chequebook/transactionIdentity.js';
import { BeeHttpError } from '../errors/BeeHttpError.js';
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

/** Gnosis Chain's block time in seconds, five, as the manager's own stamp arithmetic counts it (`stampCost.ts`). */
export const FUNDING_BLOCK_SECONDS = Number(BLOCK_TIME_SECONDS);

/**
 * The postage contract's floor, the least life a batch may be bought or left with, in blocks: a day of them, 17280,
 * from the day the manager's own stamp checks hold a batch to (`MINIMUM_STAMP_VALIDITY_SECONDS`).
 */
export const FUNDING_MINIMUM_VALIDITY_BLOCKS = Number(MINIMUM_STAMP_VALIDITY_SECONDS / BLOCK_TIME_SECONDS);

/** What one wallet read came to, with no node address in it. */
type WalletReading =
  | { ok: true; walletAddress: string; xdaiWei: string; xbzzPlur: string }
  | { ok: false; readError: string };

/** One node to read: the inventory's own fields, how to reach it, which never leaves this service, and its batch. */
interface PlannedNode {
  nodeId: string;
  label: string;
  role: FundingNodeRole;
  apiUrl: () => Promise<string>;
  /**
   * The batch the manager uses for the node's uploads, 64 hex digits in lower case without `0x`, as the stage records
   * spell one, or null: a gateway's, and a node's with no batch set.
   */
  batchId: string | null;
}

/** A node as the inventory answers it, and the price of postage its chain state names, kept where its wallet reads. */
interface NodeAnswer {
  node: FundingNode;
  /** PLUR per chunk per block, or null when the node's wallet or its chain state could not be read. */
  price: string | null;
}

/** The reads of one inventory, each made once however many stages name the node: by its address, and its batch. */
interface Reads {
  wallets: Map<string, Promise<WalletReading>>;
  batches: Map<string, Promise<FundingBatch>>;
  prices: Map<string, Promise<string | null>>;
}

export interface FundingInventoryDeps {
  profiles: { list(): Promise<Profile[]> };
  /** The catalogue designation, whose deployment and batch in force are the catalogue node and its batch. */
  catalogue: { read(): Promise<CatalogueDesignationRow> };
  /** The Bee API of a deployment's own `bee-uploader`, as the manager reaches it, `beeApiUrlFor`. */
  uploaderApiUrl(profile: Profile): string;
  /** The Bee API of a deployment's `bee-gateway`, from the port its next deploy gives it. */
  gatewayApiUrl(profile: Profile): Promise<string>;
  /** `GET /wallet` on the Bee API at this address, `BeeClient.getWallet()`. */
  wallet(apiUrl: string): Promise<BeeWallet>;
  /** `GET /stamps/{id}` on the Bee API at this address, for a batch id without `0x`, `BeeClient.getStamp()`. */
  stamp(apiUrl: string, batchId: string): Promise<BeeStamp>;
  /** `GET /chainstate` on the Bee API at this address, `BeeClient.getChainState()`. */
  chainState(apiUrl: string): Promise<BeeChainState>;
  now?: () => Date;
}

/** A batch id as a stamp id records it, without `0x` and in lower case, as the stage records compare them. */
function batchIdOf(stampId: string): string {
  return stampId.replace(/^0x/i, '').toLowerCase();
}

const BATCH_ID = /^[0-9a-f]{64}$/;

/**
 * A recorded batch id as the inventory reads batches by, or null when none is recorded. The profile and designation
 * schemas take only batch ids, so one that is not is read as none rather than answered.
 */
function recordedBatchId(stampId: string | null | undefined): string | null {
  const recorded = stampId?.trim();
  if (!recorded) return null;
  const id = batchIdOf(recorded);
  return BATCH_ID.test(id) ? id : null;
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

const NOT_A_BATCH = 'The node answered something that is not this batch.';
const BATCH_NOT_HELD = 'The node does not hold this batch: it expired and was dropped, or it is another node’s.';
const BATCH_GONE = 'The batch is gone from the chain: it expired.';

/** Why a batch read failed, in a sentence with no address in it. */
function batchReadErrorOf(error: unknown): string {
  // Bee answers 404 for a batch it does not own, which is an answer and not a failure to answer.
  if (error instanceof BeeHttpError && error.status === 404) return BATCH_NOT_HELD;
  switch (readFailureFrom(error, 0).reason) {
    case 'timeout':
      return 'The node did not answer in time.';
    case 'refused':
      return 'The node refused to say how this batch stands.';
    case 'malformed':
      return NOT_A_BATCH;
    default:
      return 'The node could not be reached.';
  }
}

/** A batch the node could not be read about: its id, no reading, and why in a sentence. */
function unreadBatch(batchId: string, readError: string): FundingBatch {
  return {
    batchId: `0x${batchId}`,
    depth: null,
    immutable: null,
    usable: null,
    ttlSeconds: null,
    fillRatio: null,
    readError,
  };
}

/** The deepest a batch can be: the postage contract keeps a batch's depth in a byte. */
const MAX_DEPTH = 255;

function isDepth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_DEPTH;
}

/**
 * A node's `GET /stamps/{id}` answer as the inventory takes it, or the batch unread and why. The fill is the fullest
 * bucket's, worked out as the postage page works it out (`fullestBucketFillRatio`).
 */
function batchFrom(batchId: string, stamp: BeeStamp): FundingBatch {
  const answered: Partial<Record<keyof BeeStamp, unknown>> = typeof stamp === 'object' && stamp !== null ? stamp : {};
  if (typeof answered.batchID !== 'string' || batchIdOf(answered.batchID) !== batchId) {
    return unreadBatch(batchId, NOT_A_BATCH);
  }
  if (answered.exists === false) return unreadBatch(batchId, BATCH_GONE);
  const { depth, usable, immutableFlag, batchTTL } = answered;
  if (!isDepth(depth) || typeof usable !== 'boolean' || typeof immutableFlag !== 'boolean') {
    return unreadBatch(batchId, NOT_A_BATCH);
  }
  const fillRatio = fullestBucketFillRatio(stamp);
  return {
    batchId: `0x${batchId}`,
    depth,
    immutable: immutableFlag,
    usable,
    // Bee answers a negative time left when it cannot work one out, which is not expired.
    ttlSeconds: typeof batchTTL === 'number' && Number.isSafeInteger(batchTTL) && batchTTL >= 0 ? batchTTL : null,
    // A fullest bucket holding more than a bucket holds contradicts the depths, so it is read as not known.
    fillRatio: fillRatio !== null && fillRatio <= 1 ? fillRatio : null,
    readError: null,
  };
}

/** Base units as the contract takes them: decimal digits, 78 at most, the most a 256-bit number has. */
const PRICE_DIGITS = /^\d{1,78}$/;

/**
 * The price a node's `/chainstate` names, PLUR per chunk per block, or null when it names none above nothing. Bee
 * writes it as a decimal string; a whole number is taken as well.
 */
function priceFrom(state: BeeChainState): string | null {
  const price: unknown = (state as { currentPrice?: unknown } | null)?.currentPrice;
  let value: bigint | null = null;
  if (typeof price === 'string' && PRICE_DIGITS.test(price)) value = BigInt(price);
  if (typeof price === 'number' && Number.isSafeInteger(price)) value = BigInt(price);
  return value !== null && value > 0n ? value.toString() : null;
}

/** What postage costs at this price on Gnosis Chain, or null for no price. */
function postageOf(price: string | null): FundingPostage | null {
  if (price === null) return null;
  return {
    pricePerChunkPerBlockPlur: price,
    blockSeconds: FUNDING_BLOCK_SECONDS,
    minimumValidityBlocks: FUNDING_MINIMUM_VALIDITY_BLOCKS,
  };
}

/**
 * `GET /api/admin-funding/inventory`: every stage's nodes and the brand's catalogue node, each with its wallet and
 * its batch as the node reports them now, or the reason they could not be read, and what postage costs now.
 *
 * A stage is a deployment that runs a stream uploader. Its nodes are its own `bee-uploader`, its `bee-gateway` when
 * that runs light (an ultra-light gateway is on no chain and has no wallet), and the rungs of its ABR pool, lowest
 * first, each the deployment of this manager that stamps with that rung's batch, as the stage records find them. A
 * rung whose node this manager does not run is left out, since nothing could be sent to it through this manager.
 *
 * Each node's batch is the one the manager uses for its uploads: the stage's own batch (`stamp_id`) for the stage's
 * own node, the rung's batch for a rung, and the designated batch for the catalogue node, never the one a pending
 * move left. A gateway has none. The batch is read from the node's `GET /stamps/{id}`, and the price of postage from
 * the `/chainstate` of the first node listed whose wallet reads on Gnosis Chain, since the price is the chain's.
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
    const reads: Reads = { wallets: new Map(), batches: new Map(), prices: new Map() };
    const read = (planned: PlannedNode) => this.nodeOf(planned, reads);

    const stages = await Promise.all(
      profiles
        .filter((profile) => isStageKind(profile.kind))
        .map(async (stage) => ({ stage, answers: await Promise.all(this.nodesOf(stage, profiles).map(read)) })),
    );
    const catalogueNode = await this.catalogueNodeOf(profiles);
    const catalogue = catalogueNode ? await read(catalogueNode) : null;
    const listed = [...stages.flatMap(({ answers }) => answers), ...(catalogue ? [catalogue] : [])];
    const price = listed.find((answer) => answer.price !== null)?.price ?? null;

    const answer: FundingInventory = {
      observedAt,
      chain: { chainId: FUNDING_CHAIN_ID, bzzToken: FUNDING_BZZ_TOKEN, postage: postageOf(price) },
      stages: stages.map(({ stage, answers }) => ({
        stageId: stage.instance_id,
        name: stage.name,
        nodes: answers.map(({ node }) => node),
      })),
      catalogue: catalogue?.node ?? null,
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
        batchId: recordedBatchId(stage.stamp_id),
      });
    }
    if (gatewayNodeMode(stage) === LIGHT_NODE_MODE) {
      nodes.push({
        nodeId: `${stage.instance_id}:${BEE_GATEWAY_SERVICE}`,
        label: `${stage.name} gateway`,
        role: 'gateway',
        apiUrl: () => this.deps.gatewayApiUrl(stage),
        batchId: null,
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
        // The pool string's batch, which is the rung's own, since that is how its node was found.
        batchId: recordedBatchId(entry.batchId),
      });
    }
    return nodes;
  }

  /**
   * The catalogue node, when a designation is in force and its deployment is still here, with the designated batch.
   * While a move is pending, the batch the catalogue moved from is the row's `movingFrom` one, which is not read.
   */
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
      batchId: recordedBatchId(row.batchId),
    };
  }

  /** One node with its wallet, its batch and its chain state's price, each read once however many stages name it. */
  private async nodeOf(planned: PlannedNode, reads: Reads): Promise<NodeAnswer> {
    let apiUrl: string;
    try {
      apiUrl = await planned.apiUrl();
    } catch (err) {
      logger.debug(`[Funding] could not work out the address of ${planned.label}: ${getErrorMessage(err)}`);
      const readError = addressErrorOf(planned.role);
      const batch = planned.batchId === null ? null : unreadBatch(planned.batchId, readError);
      return { node: this.unread(planned, readError, batch), price: null };
    }
    const [reading, batch, price] = await Promise.all([
      this.walletOf(planned, apiUrl, reads),
      planned.batchId === null ? null : this.batchOf(planned, planned.batchId, apiUrl, reads),
      this.priceOf(planned, apiUrl, reads),
    ]);
    if (!reading.ok) return { node: this.unread(planned, reading.readError, batch), price: null };
    const { nodeId, label, role } = planned;
    return { node: { nodeId, label, role, ...pick(reading), readError: null, batch }, price };
  }

  /** The node's wallet, or why it could not be read. Never throws. */
  private async walletOf(planned: PlannedNode, apiUrl: string, reads: Reads): Promise<WalletReading> {
    try {
      let pending = reads.wallets.get(apiUrl);
      if (!pending) {
        pending = this.deps.wallet(apiUrl).then(readingOf, (err: unknown) => {
          logger.debug(`[Funding] could not read the wallet of ${planned.label}: ${readErrorOf(err)}`);
          return { ok: false, readError: readErrorOf(err) } as const;
        });
        reads.wallets.set(apiUrl, pending);
      }
      return await pending;
    } catch (err) {
      return { ok: false, readError: readErrorOf(err) };
    }
  }

  /** The node's batch as it reports it, or unread and why. Never throws. */
  private async batchOf(planned: PlannedNode, batchId: string, apiUrl: string, reads: Reads): Promise<FundingBatch> {
    const key = `${apiUrl} ${batchId}`;
    try {
      let pending = reads.batches.get(key);
      if (!pending) {
        pending = this.deps.stamp(apiUrl, batchId).then(
          (stamp) => batchFrom(batchId, stamp),
          (err: unknown) => {
            logger.debug(`[Funding] could not read batch ${batchId} of ${planned.label}: ${batchReadErrorOf(err)}`);
            return unreadBatch(batchId, batchReadErrorOf(err));
          },
        );
        reads.batches.set(key, pending);
      }
      return await pending;
    } catch (err) {
      return unreadBatch(batchId, batchReadErrorOf(err));
    }
  }

  /** The price the node's chain state names, or null when it could not be read. Never throws. */
  private async priceOf(planned: PlannedNode, apiUrl: string, reads: Reads): Promise<string | null> {
    try {
      let pending = reads.prices.get(apiUrl);
      if (!pending) {
        pending = this.deps.chainState(apiUrl).then(priceFrom, (err: unknown) => {
          logger.debug(
            `[Funding] could not read the chain state of ${planned.label}: ${readFailureFrom(err, 0).reason}`,
          );
          return null;
        });
        reads.prices.set(apiUrl, pending);
      }
      return await pending;
    } catch {
      return null;
    }
  }

  /** A node answered with no wallet, and why in a sentence, with its batch as it was read. */
  private unread({ nodeId, label, role }: PlannedNode, readError: string, batch: FundingBatch | null): FundingNode {
    return { nodeId, label, role, walletAddress: null, xdaiWei: null, xbzzPlur: null, readError, batch };
  }
}

function pick(reading: Extract<WalletReading, { ok: true }>) {
  return { walletAddress: reading.walletAddress, xdaiWei: reading.xdaiWei, xbzzPlur: reading.xbzzPlur };
}
