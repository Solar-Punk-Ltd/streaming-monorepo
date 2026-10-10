/**
 * In-memory stand-ins for what the funding services depend on, and the readings a test starts from.
 *
 * The stores copy the semantics of the SQL that matter: a journal's update writes only while an item is unsettled
 * (a stamp or chequebook item: still asked about) and answers null otherwise; the send, stamp and chequebook locks are
 * taken without waiting, as `pg_try_advisory_lock` is, and a second taker gets `{ locked: false }`; rows go in and come
 * out as copies. The wallet signs for real, with a key the test generates, so a test reads back exactly what would go
 * to the chain. The manager journals what it is relayed, as the real one does, so a status read for a request id it
 * never took answers `unknown_request`; it runs a stamp or chequebook operation once per request id, answers the same
 * request id again with its state, and another body under it with `conflict`.
 *
 * Addresses are fixtures the leak gate allows (`scripts/public-leaks/allow.json`) or derived from a generated key.
 */
import type {
  FundingAccountAnswer,
  FundingBatch,
  FundingChequebook,
  FundingChequebookOperationAnswer,
  FundingChequebookOperationRequest,
  FundingChequebookOperationStatus,
  FundingInventory,
  FundingNode,
  FundingPostage,
  FundingStampOperationAnswer,
  FundingStampOperationRequest,
  FundingStampOperationStatus,
  FundingTransferAnswer,
  FundingTransferRequest,
  FundingTransferState,
  FundingTransferStatus,
} from '@streaming-monorepo/contracts';
import { type Address, type Hex, keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  type ChequebookLockOutcome,
  type FundingChequebookRow,
  type FundingChequebookStore,
  type FundingChequebookUpdate,
  holdsChequebookBulk,
  isChequebookAsked,
  type NewFundingChequebookOperation,
} from '../../../src/domain/funding/FundingChequebookRepository.js';
import type { FundingChequebookManager } from '../../../src/domain/funding/FundingChequebookService.js';
import type {
  FundingPinRow,
  FundingPinStore,
  NewFundingPin,
} from '../../../src/domain/funding/FundingPinRepository.js';
import type { BrandWalletTransaction } from '../../../src/domain/funding/BrandWallet.js';
import type { FundingManager, FundingWallet } from '../../../src/domain/funding/FundingService.js';
import {
  holdsStampBulk,
  isStampAsked,
  type FundingStampRow,
  type FundingStampStore,
  type FundingStampUpdate,
  type NewFundingStampOperation,
  type StampLockOutcome,
} from '../../../src/domain/funding/FundingStampRepository.js';
import type { FundingStampManager } from '../../../src/domain/funding/FundingStampService.js';
import {
  holdsSend,
  isAsked,
  type FundingTransferRow,
  type FundingTransferStore,
  type FundingTransferUpdate,
  type NewFundingTransfer,
  type SendLockOutcome,
} from '../../../src/domain/funding/FundingTransferRepository.js';
import { ManagerFundingError } from '../../../src/domain/funding/ManagerFundingClient.js';

import { STAGE_ID } from './stageFakes.js';

/** Node wallets: fixtures of one repeated digit, and one of counting digits. */
export const WALLET_A = '0x1111111111111111111111111111111111111111';
export const WALLET_B = '0x2222222222222222222222222222222222222222';
export const WALLET_C = '0x1234567890123456789012345678901234567890';
/** The public BZZ token contract on Gnosis Chain. */
export const BZZ_TOKEN = '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';

export const NODE_A = 'stage-1:uploader';
export const NODE_B = 'stage-1:gateway';
export const NODE_CATALOGUE = 'catalogue:uploader';

export const ONE_XDAI = 10n ** 18n;
export const ONE_XBZZ = 10n ** 16n;

/** Batch ids: fixtures of one repeated byte, as the contract keeps them, in lower case. */
export const BATCH_STAGE = `0x${'b1'.repeat(32)}`;
export const BATCH_CATALOGUE = `0x${'c2'.repeat(32)}`;
export const BATCH_RUNG = `0x${'d3'.repeat(32)}`;

/** Seconds in a day. */
export const DAY = 86_400;

/** What postage costs in the tests: 24000 PLUR a chunk a block, 5-second blocks, and a day of blocks as the floor. */
export const POSTAGE: FundingPostage = {
  pricePerChunkPerBlockPlur: '24000',
  blockSeconds: 5,
  minimumValidityBlocks: 17_280,
};

/** A batch read whole: depth 20, mutable, usable, 10 days left, a quarter full. */
export function fundingBatch(over: Partial<FundingBatch> = {}): FundingBatch {
  return {
    batchId: BATCH_STAGE,
    depth: 20,
    immutable: false,
    usable: true,
    ttlSeconds: 10 * DAY,
    fillRatio: 0.25,
    readError: null,
    ...over,
  };
}

export function fundingNode(over: Partial<FundingNode> = {}): FundingNode {
  return {
    nodeId: NODE_A,
    label: 'Main stage uploader',
    role: 'uploader',
    walletAddress: WALLET_A,
    xdaiWei: '1000',
    xbzzPlur: '2000',
    readError: null,
    ...over,
  };
}

/** One stage with two nodes, and a catalogue node, on Gnosis Chain. */
export function fundingInventory(over: Partial<FundingInventory> = {}): FundingInventory {
  return {
    observedAt: '2026-10-05T10:00:00.000Z',
    chain: { chainId: 100, bzzToken: BZZ_TOKEN },
    stages: [
      {
        stageId: STAGE_ID,
        name: 'Main stage',
        nodes: [
          fundingNode(),
          fundingNode({ nodeId: NODE_B, label: 'Main stage gateway', role: 'gateway', walletAddress: WALLET_B }),
        ],
      },
    ],
    catalogue: fundingNode({ nodeId: NODE_CATALOGUE, label: 'Catalogue node', walletAddress: WALLET_C }),
    ...over,
  };
}

/** A rung's node, on another deployment, and its wallet: the fixture of a made-up rung owner. */
export const NODE_RUNG = 'stage-2:uploader';
export const WALLET_RUNG = '0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09';

/**
 * The inventory a stamp request is checked against: the stage's own node with its batch at depth 20 and 10 days left,
 * its gateway with no batch, a rung's node at depth 22 with 30 days, and the catalogue node at depth 18 with 40 days;
 * every wallet holds 5 xBZZ and 0.1 xDAI, and postage costs {@link POSTAGE}.
 */
export function stampInventory(): FundingInventory {
  const funded = { xdaiWei: (ONE_XDAI / 10n).toString(), xbzzPlur: (5n * ONE_XBZZ).toString() };
  return fundingInventory({
    chain: { chainId: 100, bzzToken: BZZ_TOKEN, postage: POSTAGE },
    stages: [
      {
        stageId: STAGE_ID,
        name: 'Main stage',
        nodes: [
          fundingNode({ ...funded, batch: fundingBatch() }),
          fundingNode({
            nodeId: NODE_B,
            label: 'Main stage gateway',
            role: 'gateway',
            walletAddress: WALLET_B,
            ...funded,
            batch: null,
          }),
          fundingNode({
            nodeId: NODE_RUNG,
            label: 'Main stage 720p rung',
            role: 'rung',
            walletAddress: WALLET_RUNG,
            ...funded,
            batch: fundingBatch({ batchId: BATCH_RUNG, depth: 22, ttlSeconds: 30 * DAY }),
          }),
        ],
      },
    ],
    catalogue: fundingNode({
      nodeId: NODE_CATALOGUE,
      label: 'Catalogue node',
      walletAddress: WALLET_C,
      ...funded,
      batch: fundingBatch({ batchId: BATCH_CATALOGUE, depth: 18, ttlSeconds: 40 * DAY }),
    }),
  });
}

/** The hash the fake manager answers for a stamp operation it confirmed. */
export function stampTxHash(requestId: string): string {
  return keccak256(toHex(requestId));
}

/** A chequebook's address: the fixture of one repeated digit, the same for every node, since nothing checks it. */
export const CHEQUEBOOK_ADDRESS = '0x3333333333333333333333333333333333333333';

/** A chequebook read whole: 1.5 xBZZ available of 2 in all, so 0.5 xBZZ in cheques its peers have not cashed. */
export function fundingChequebook(over: Partial<FundingChequebook> = {}): FundingChequebook {
  return {
    address: CHEQUEBOOK_ADDRESS,
    availablePlur: ((3n * ONE_XBZZ) / 2n).toString(),
    totalPlur: (2n * ONE_XBZZ).toString(),
    readError: null,
    ...over,
  };
}

/**
 * The inventory a chequebook request is checked against: the stage's own node with 1.5 xBZZ available in its
 * chequebook, its gateway with 3, a rung's node with 3.25, and the catalogue node with 1; every wallet holds 5 xBZZ
 * and 0.1 xDAI. Against a target of 2 xBZZ, the stage's node takes a deposit of 0.5 and the rung a withdrawal of 1.25.
 */
export function chequebookInventory(): FundingInventory {
  const funded = { xdaiWei: (ONE_XDAI / 10n).toString(), xbzzPlur: (5n * ONE_XBZZ).toString() };
  return fundingInventory({
    stages: [
      {
        stageId: STAGE_ID,
        name: 'Main stage',
        nodes: [
          fundingNode({ ...funded, chequebook: fundingChequebook() }),
          fundingNode({
            nodeId: NODE_B,
            label: 'Main stage gateway',
            role: 'gateway',
            walletAddress: WALLET_B,
            ...funded,
            chequebook: fundingChequebook({ availablePlur: (3n * ONE_XBZZ).toString() }),
          }),
          fundingNode({
            nodeId: NODE_RUNG,
            label: 'Main stage 720p rung',
            role: 'rung',
            walletAddress: WALLET_RUNG,
            ...funded,
            chequebook: fundingChequebook({
              availablePlur: ((13n * ONE_XBZZ) / 4n).toString(),
              totalPlur: (4n * ONE_XBZZ).toString(),
            }),
          }),
        ],
      },
    ],
    catalogue: fundingNode({
      nodeId: NODE_CATALOGUE,
      label: 'Catalogue node',
      walletAddress: WALLET_C,
      ...funded,
      chequebook: fundingChequebook({ availablePlur: ONE_XBZZ.toString() }),
    }),
  });
}

/** The hash the fake manager answers for a chequebook operation the node submitted. */
export function chequebookTxHash(requestId: string): string {
  return keccak256(toHex(`chequebook ${requestId}`));
}

/** The brand wallet's account: 10 xDAI, 100 xBZZ, nonce 7, a fee cap of 2 gwei and a tip of 1. */
export function fundingAccount(address: string, over: Partial<FundingAccountAnswer> = {}): FundingAccountAnswer {
  return {
    address: address.toLowerCase(),
    chainId: 100,
    xdaiWei: (10n * ONE_XDAI).toString(),
    xbzzPlur: (100n * ONE_XBZZ).toString(),
    nonce: 7,
    maxFeePerGasWei: '2000000000',
    maxPriorityFeePerGasWei: '1000000000',
    gasNative: '21000',
    gasBzzTransfer: '60000',
    ...over,
  };
}

/** A failed manager call as the real client throws it: the contract's code or a failure's, and a status. */
export function managerFailure(
  code: ManagerFundingError['code'],
  status: number | null,
  message = `The manager failed with ${code}.`,
): ManagerFundingError {
  return new ManagerFundingError(code, status, message);
}

/** The brand wallet, with a key generated for the test, signing exactly as `BrandWallet.signTransaction` does. */
export class FakeFundingWallet implements FundingWallet {
  readonly privateKey: Hex = generatePrivateKey();
  private readonly account = privateKeyToAccount(this.privateKey);
  /** What each signature was asked for, in order. */
  readonly signed: BrandWalletTransaction[] = [];
  /** Set to false to stand for a wallet with no key: `BRAND_WALLET_SECRET` unset. */
  present = true;

  address(): Address | null {
    return this.present ? (this.account.address.toLowerCase() as Address) : null;
  }

  async signTransaction(transaction: BrandWalletTransaction): Promise<Hex> {
    this.signed.push(transaction);
    return this.account.signTransaction({
      type: 'eip1559',
      chainId: transaction.chainId,
      nonce: transaction.nonce,
      to: transaction.to,
      value: transaction.value,
      data: transaction.data,
      gas: transaction.gas,
      maxFeePerGas: transaction.maxFeePerGas,
      maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
    });
  }
}

/**
 * The manager's funding API. By default it answers the inventory and the account above, takes every relay as
 * `submitted` and journals it, and answers a status read from that journal, in the state the relay was answered with,
 * `unknown_request` for an id it never took. A stamp operation it journals and runs once per request id, answered
 * `confirmed` by default; the same request again answers its state, and another body under its id `conflict`. A
 * chequebook operation likewise, answered `submitted` with its hash by default, as the manager answers once the node
 * has sent the move, and settled only when a test says so. Each call can be made to fail, or to wait on a gate.
 */
export class FakeFundingManager implements FundingManager, FundingStampManager, FundingChequebookManager {
  inventoryAnswer: FundingInventory = fundingInventory();
  accountAnswer: (address: string) => FundingAccountAnswer = (address) => fundingAccount(address);
  inventoryError: Error | null = null;
  accountError: Error | null = null;
  /** A relay's failure by the order of the relay call, 0 first, or for every call when `relayErrorAlways` is set. */
  relayErrors = new Map<number, Error>();
  relayErrorAlways: Error | null = null;
  /** The state a relay is answered with. */
  relayState: FundingTransferAnswer['state'] = 'submitted';
  statusError: Error | null = null;
  /** What a status read answers for a request id, over the journal. */
  statusAnswers = new Map<string, Partial<FundingTransferStatus>>();
  /** Called at the start of each relay, before anything is answered. */
  onRelay: ((transfer: FundingTransferRequest) => void) | null = null;
  /** When set, `account` waits for it, so a test can hold a send inside the lock. */
  accountGate: Promise<void> | null = null;

  readonly calls = { inventory: 0, account: 0, relay: 0, status: 0 };
  readonly relays: FundingTransferRequest[] = [];
  readonly statusReads: string[] = [];
  /** What the manager journalled: each relay it took, by request id. */
  readonly journal = new Map<string, FundingTransferRequest>();
  /** The state each relay it took was answered with, which a status read answers until told otherwise. */
  readonly journalState = new Map<string, FundingTransferAnswer['state']>();

  /** The state a stamp operation is answered with when the manager runs it. */
  stampState: FundingTransferState = 'confirmed';
  /** When set, the state each operation is answered with when the manager runs it, over `stampState`. */
  stampStateOf: ((operation: FundingStampOperationRequest) => FundingTransferState) | null = null;
  /** The sentence a stamp status read gives an operation that failed, unless told otherwise. */
  stampFailure = 'The node refused it: its wallet holds too little xBZZ.';
  /** A stamp operation's failure by the order of the call, 0 first, or for every call when `stampErrorAlways` is set. */
  stampErrors = new Map<number, Error>();
  stampErrorAlways: Error | null = null;
  stampStatusError: Error | null = null;
  /** What a stamp status read answers for a request id, over the journal. */
  stampStatusAnswers = new Map<string, Partial<FundingStampOperationStatus>>();
  /** Called at the start of each stamp operation, before anything is answered. */
  onStampOperation: ((operation: FundingStampOperationRequest) => void) | null = null;
  /** When set, a stamp operation waits for it before it is answered, as the manager waits on the node and the chain. */
  stampGate: Promise<void> | null = null;

  readonly stampCalls = { operation: 0, status: 0 };
  /** Every stamp operation relayed to it, in order, as it came. */
  readonly stampOperations: FundingStampOperationRequest[] = [];
  readonly stampStatusReads: string[] = [];
  /** What the manager journalled: each stamp operation it took, by request id. */
  readonly stampJournal = new Map<string, FundingStampOperationRequest>();
  /** The state each journalled operation stands in, which a status read answers until told otherwise. */
  readonly stampJournalState = new Map<string, FundingTransferState>();
  /** What the manager asked the nodes for: one operation per request id, however often it was relayed. */
  readonly stampRuns: FundingStampOperationRequest[] = [];

  /** The state a chequebook operation is answered with when the manager runs it. */
  chequebookState: FundingTransferState = 'submitted';
  /** When set, the state each chequebook operation is answered with when the manager runs it, over `chequebookState`. */
  chequebookStateOf: ((operation: FundingChequebookOperationRequest) => FundingTransferState) | null = null;
  /** The sentence a chequebook status read gives an operation that failed, unless told otherwise. */
  chequebookFailure = "The node's wallet holds too little xBZZ for the deposit. Nothing was sent.";
  /** A chequebook operation's failure by the order of the call, 0 first, or for every call with the `Always` one. */
  chequebookErrors = new Map<number, Error>();
  chequebookErrorAlways: Error | null = null;
  chequebookStatusError: Error | null = null;
  /** What a chequebook status read answers for a request id, over the journal. */
  chequebookStatusAnswers = new Map<string, Partial<FundingChequebookOperationStatus>>();
  /** Called at the start of each chequebook operation, before anything is answered. */
  onChequebookOperation: ((operation: FundingChequebookOperationRequest) => void) | null = null;
  /** When set, a chequebook operation waits for it before it is answered, as the manager waits on the node. */
  chequebookGate: Promise<void> | null = null;

  readonly chequebookCalls = { operation: 0, status: 0 };
  /** Every chequebook operation relayed to it, in order, as it came. */
  readonly chequebookOperations: FundingChequebookOperationRequest[] = [];
  readonly chequebookStatusReads: string[] = [];
  /** What the manager journalled: each chequebook operation it took, by request id. */
  readonly chequebookJournal = new Map<string, FundingChequebookOperationRequest>();
  /** The state each journalled chequebook operation stands in, which a status read answers until told otherwise. */
  readonly chequebookJournalState = new Map<string, FundingTransferState>();
  /** What the manager asked the nodes for: one move per request id, however often it was relayed. */
  readonly chequebookRuns: FundingChequebookOperationRequest[] = [];

  async inventory(): Promise<FundingInventory> {
    this.calls.inventory += 1;
    await Promise.resolve();
    if (this.inventoryError) throw this.inventoryError;
    return structuredClone(this.inventoryAnswer);
  }

  async account(address: string): Promise<FundingAccountAnswer> {
    this.calls.account += 1;
    if (this.accountGate) await this.accountGate;
    await Promise.resolve();
    if (this.accountError) throw this.accountError;
    return this.accountAnswer(address);
  }

  async relay(transfer: FundingTransferRequest): Promise<FundingTransferAnswer> {
    const call = this.calls.relay;
    this.calls.relay += 1;
    this.onRelay?.(transfer);
    this.relays.push({ ...transfer });
    await Promise.resolve();
    const error = this.relayErrorAlways ?? this.relayErrors.get(call);
    if (error) throw error;
    this.journal.set(transfer.requestId, { ...transfer });
    this.journalState.set(transfer.requestId, this.relayState);
    return {
      requestId: transfer.requestId,
      state: this.relayState,
      txHash: keccak256(transfer.rawTransaction as Hex),
    };
  }

  async status(requestId: string): Promise<FundingTransferStatus> {
    this.calls.status += 1;
    this.statusReads.push(requestId);
    await Promise.resolve();
    if (this.statusError) throw this.statusError;
    const taken = this.journal.get(requestId);
    const answer = this.statusAnswers.get(requestId);
    if (!taken && !answer) {
      throw managerFailure('unknown_request', 404, 'No transfer was journalled under this request id.');
    }
    return {
      requestId,
      state: this.journalState.get(requestId) ?? 'submitted',
      txHash: taken ? keccak256(taken.rawTransaction as Hex) : null,
      blockNumber: null,
      error: null,
      ...answer,
    };
  }

  async stampOperation(operation: FundingStampOperationRequest): Promise<FundingStampOperationAnswer> {
    const call = this.stampCalls.operation;
    this.stampCalls.operation += 1;
    this.onStampOperation?.(operation);
    this.stampOperations.push(structuredClone(operation));
    if (this.stampGate) await this.stampGate;
    await Promise.resolve();
    const error = this.stampErrorAlways ?? this.stampErrors.get(call);
    if (error) throw error;
    const taken = this.stampJournal.get(operation.requestId);
    if (taken && JSON.stringify(taken) !== JSON.stringify(operation)) {
      throw managerFailure('conflict', 409, 'Another stamp operation has this request id.');
    }
    if (!taken) {
      this.stampJournal.set(operation.requestId, structuredClone(operation));
      this.stampJournalState.set(operation.requestId, this.stampStateOf?.(operation) ?? this.stampState);
      this.stampRuns.push(structuredClone(operation));
    }
    const state = this.stampJournalState.get(operation.requestId) ?? this.stampState;
    return {
      requestId: operation.requestId,
      kind: operation.kind,
      state,
      txHash: state === 'confirmed' ? stampTxHash(operation.requestId) : null,
    };
  }

  async stampOperationStatus(requestId: string): Promise<FundingStampOperationStatus> {
    this.stampCalls.status += 1;
    this.stampStatusReads.push(requestId);
    await Promise.resolve();
    if (this.stampStatusError) throw this.stampStatusError;
    const taken = this.stampJournal.get(requestId);
    const answer = this.stampStatusAnswers.get(requestId);
    if (!taken && !answer) {
      throw managerFailure('unknown_request', 404, 'No stamp operation was journalled under this request id.');
    }
    const state = this.stampJournalState.get(requestId) ?? 'submitted';
    return {
      requestId,
      kind: taken?.kind ?? 'topup',
      state,
      txHash: state === 'confirmed' ? stampTxHash(requestId) : null,
      error: state === 'failed' ? this.stampFailure : null,
      ...answer,
    };
  }

  async chequebookOperation(operation: FundingChequebookOperationRequest): Promise<FundingChequebookOperationAnswer> {
    const call = this.chequebookCalls.operation;
    this.chequebookCalls.operation += 1;
    this.onChequebookOperation?.(operation);
    this.chequebookOperations.push(structuredClone(operation));
    if (this.chequebookGate) await this.chequebookGate;
    await Promise.resolve();
    const error = this.chequebookErrorAlways ?? this.chequebookErrors.get(call);
    if (error) throw error;
    const taken = this.chequebookJournal.get(operation.requestId);
    if (taken && JSON.stringify(taken) !== JSON.stringify(operation)) {
      throw managerFailure('conflict', 409, 'Another chequebook operation has this request id.');
    }
    if (!taken) {
      this.chequebookJournal.set(operation.requestId, structuredClone(operation));
      this.chequebookJournalState.set(operation.requestId, this.chequebookStateOf?.(operation) ?? this.chequebookState);
      this.chequebookRuns.push(structuredClone(operation));
    }
    const state = this.chequebookJournalState.get(operation.requestId) ?? this.chequebookState;
    return {
      requestId: operation.requestId,
      direction: operation.direction,
      state,
      txHash: state === 'submitted' || state === 'confirmed' ? chequebookTxHash(operation.requestId) : null,
    };
  }

  async chequebookOperationStatus(requestId: string): Promise<FundingChequebookOperationStatus> {
    this.chequebookCalls.status += 1;
    this.chequebookStatusReads.push(requestId);
    await Promise.resolve();
    if (this.chequebookStatusError) throw this.chequebookStatusError;
    const taken = this.chequebookJournal.get(requestId);
    const answer = this.chequebookStatusAnswers.get(requestId);
    if (!taken && !answer) {
      throw managerFailure('unknown_request', 404, 'No chequebook operation was journalled under this request id.');
    }
    const state = this.chequebookJournalState.get(requestId) ?? 'submitted';
    return {
      requestId,
      direction: taken?.direction ?? 'deposit',
      state,
      txHash: state === 'submitted' || state === 'confirmed' ? chequebookTxHash(requestId) : null,
      error: state === 'failed' ? this.chequebookFailure : null,
      ...answer,
    };
  }
}

/** The funding journal in memory. */
export class InMemoryFundingTransferStore implements FundingTransferStore {
  readonly rows = new Map<string, FundingTransferRow>();
  private locked = false;
  /** How many times the lock was refused to a second taker. */
  lockRefusals = 0;

  async withSendLock<T>(work: () => Promise<T>): Promise<SendLockOutcome<T>> {
    if (this.locked) {
      this.lockRefusals += 1;
      return { locked: false };
    }
    this.locked = true;
    try {
      return { locked: true, result: await work() };
    } finally {
      this.locked = false;
    }
  }

  async hasUnsettled(now: Date): Promise<boolean> {
    return [...this.rows.values()].some((row) => holdsSend(row, now.getTime()));
  }

  async openBulkIds(limit: number, now: Date): Promise<string[]> {
    return this.bulkIdsWhere((row) => holdsSend(row, now.getTime()), limit);
  }

  async askedBulkIds(limit: number): Promise<string[]> {
    return this.bulkIdsWhere(isAsked, limit);
  }

  /** The sends with a row that matches, the latest first, as the SQL orders them by their rows' moment. */
  private bulkIdsWhere(matches: (row: FundingTransferRow) => boolean, limit: number): string[] {
    const latest = new Map<string, number>();
    for (const row of this.rows.values()) {
      if (!matches(row)) continue;
      latest.set(row.bulkId, Math.max(latest.get(row.bulkId) ?? 0, row.createdAt.getTime()));
    }
    return [...latest]
      .sort(([a, at], [b, bt]) => bt - at || a.localeCompare(b))
      .slice(0, limit)
      .map(([bulkId]) => bulkId);
  }

  async insertAll(items: readonly NewFundingTransfer[]): Promise<void> {
    // The database's clock, as the SQL's NOW() writes it.
    const at = new Date();
    for (const item of items) {
      if (this.rows.has(item.requestId)) throw new Error(`duplicate request id ${item.requestId}`);
    }
    for (const item of items) {
      this.rows.set(item.requestId, {
        ...item,
        state: 'queued',
        error: null,
        blockNumber: null,
        watched: false,
        relayedAt: null,
        createdAt: at,
        updatedAt: at,
      });
    }
  }

  async listBulk(bulkId: string): Promise<FundingTransferRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.bulkId === bulkId)
      .sort((a, b) => a.nonce - b.nonce)
      .map((row) => ({ ...row }));
  }

  async update(requestId: string, update: FundingTransferUpdate): Promise<FundingTransferRow | null> {
    const row = this.rows.get(requestId);
    if (!row || !isAsked(row)) return null;
    const next: FundingTransferRow = {
      ...row,
      state: update.state,
      error: update.error,
      blockNumber: update.blockNumber === undefined ? row.blockNumber : update.blockNumber,
      watched: update.watched,
      relayedAt: update.relayedAt ?? row.relayedAt,
      updatedAt: new Date(),
    };
    // Migration 016's CHECK: only an unknown item, or a failed one with no block, is watched.
    if (next.watched && !(next.state === 'unknown' || (next.state === 'failed' && next.blockNumber === null))) {
      throw new Error(`funding_transfers CHECK: ${requestId} cannot be watched as ${next.state}`);
    }
    this.rows.set(requestId, next);
    return { ...next };
  }

  /** A row as stored, for a test to read. */
  get(requestId: string): FundingTransferRow | undefined {
    const row = this.rows.get(requestId);
    return row ? { ...row } : undefined;
  }

  /** Sets a row's state outside the service, as an earlier send would have left it. */
  force(
    requestId: string,
    state: FundingTransferRow['state'],
    over: Partial<Pick<FundingTransferRow, 'blockNumber' | 'watched' | 'error' | 'relayedAt' | 'createdAt'>> = {},
  ): void {
    const row = this.rows.get(requestId);
    if (!row) throw new Error(`no such row: ${requestId}`);
    this.rows.set(requestId, { ...row, state, ...over });
  }
}

/** The pins in memory. */
export class InMemoryFundingPinStore implements FundingPinStore {
  readonly rows = new Map<string, FundingPinRow>();

  async all(): Promise<Map<string, FundingPinRow>> {
    return new Map([...this.rows].map(([nodeId, row]) => [nodeId, { ...row }]));
  }

  async pin(pins: readonly NewFundingPin[], pinnedBy: string): Promise<void> {
    const at = new Date();
    for (const pin of pins) {
      this.rows.set(pin.nodeId, {
        nodeId: pin.nodeId,
        walletAddress: pin.walletAddress.toLowerCase(),
        pinnedAt: at,
        pinnedBy,
      });
    }
  }

  /** Pins a node as an operator would have, earlier. */
  set(nodeId: string, walletAddress: string): void {
    this.rows.set(nodeId, { nodeId, walletAddress, pinnedAt: new Date(), pinnedBy: 'earlier-operator' });
  }
}

/** The stamp journal in memory, with migration 018's checks that matter to the service. */
export class InMemoryFundingStampStore implements FundingStampStore {
  readonly rows = new Map<string, FundingStampRow>();
  private locked = false;
  /** How many times the lock was refused to a second taker. */
  lockRefusals = 0;
  /** When set, a taker holds the lock until it resolves before its work runs, so a test can meet it there. */
  lockGate: Promise<void> | null = null;

  async withStampLock<T>(work: () => Promise<T>): Promise<StampLockOutcome<T>> {
    if (this.locked) {
      this.lockRefusals += 1;
      return { locked: false };
    }
    this.locked = true;
    try {
      if (this.lockGate) await this.lockGate;
      return { locked: true, result: await work() };
    } finally {
      this.locked = false;
    }
  }

  async hasUnsettled(now: Date): Promise<boolean> {
    return [...this.rows.values()].some((row) => holdsStampBulk(row, now.getTime()));
  }

  async openBulkIds(limit: number, now: Date): Promise<string[]> {
    return this.bulkIdsWhere((row) => holdsStampBulk(row, now.getTime()), limit);
  }

  async askedBulkIds(limit: number): Promise<string[]> {
    return this.bulkIdsWhere(isStampAsked, limit);
  }

  /** The bulks with a row that matches, the latest first, as the SQL orders them by their rows' moment. */
  private bulkIdsWhere(matches: (row: FundingStampRow) => boolean, limit: number): string[] {
    const latest = new Map<string, number>();
    for (const row of this.rows.values()) {
      if (!matches(row)) continue;
      latest.set(row.bulkId, Math.max(latest.get(row.bulkId) ?? 0, row.createdAt.getTime()));
    }
    return [...latest]
      .sort(([a, at], [b, bt]) => bt - at || a.localeCompare(b))
      .slice(0, limit)
      .map(([bulkId]) => bulkId);
  }

  async insertAll(items: readonly NewFundingStampOperation[]): Promise<void> {
    // The database's clock, as the SQL's NOW() writes it.
    const at = new Date();
    const all = [...this.rows.values(), ...items];
    for (const item of items) {
      if (this.rows.has(item.requestId)) throw new Error(`duplicate request id ${item.requestId}`);
      const sameBulk = all.filter((other) => other !== item && other.bulkId === item.bulkId);
      if (sameBulk.some((other) => other.batchId === item.batchId)) throw new Error('one_per_batch');
      if (sameBulk.some((other) => other.position === item.position)) throw new Error('bulk_position');
      const topUp =
        item.kind === 'topup' &&
        item.days !== null &&
        item.amountPerChunkPlur !== null &&
        item.costPlur !== null &&
        item.steps === null &&
        item.newDepth === null;
      const dilution =
        item.kind === 'dilute' &&
        item.steps !== null &&
        item.newDepth === item.expectedDepth + item.steps &&
        item.days === null &&
        item.amountPerChunkPlur === null &&
        item.costPlur === null;
      if (!topUp && !dilution) throw new Error(`funding_stamp_operations_kind_fields: ${item.requestId}`);
    }
    for (const item of items) {
      this.rows.set(item.requestId, {
        ...item,
        state: 'queued',
        txHash: null,
        error: null,
        relayedAt: null,
        createdAt: at,
        updatedAt: at,
      });
    }
  }

  async listBulk(bulkId: string): Promise<FundingStampRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.bulkId === bulkId)
      .sort((a, b) => a.position - b.position)
      .map((row) => ({ ...row }));
  }

  async update(requestId: string, update: FundingStampUpdate): Promise<FundingStampRow | null> {
    const row = this.rows.get(requestId);
    if (!row || !isStampAsked(row)) return null;
    const next: FundingStampRow = {
      ...row,
      state: update.state,
      error: update.error,
      txHash: update.txHash ?? row.txHash,
      relayedAt: update.relayedAt ?? row.relayedAt,
      updatedAt: new Date(),
    };
    this.rows.set(requestId, next);
    return { ...next };
  }

  /** A row as stored, for a test to read. */
  get(requestId: string): FundingStampRow | undefined {
    const row = this.rows.get(requestId);
    return row ? { ...row } : undefined;
  }

  /** Sets a row's state outside the service, as an earlier request would have left it. */
  force(
    requestId: string,
    state: FundingStampRow['state'],
    over: Partial<Pick<FundingStampRow, 'error' | 'txHash' | 'relayedAt' | 'createdAt'>> = {},
  ): void {
    const row = this.rows.get(requestId);
    if (!row) throw new Error(`no such row: ${requestId}`);
    this.rows.set(requestId, { ...row, state, ...over });
  }
}

/** Whole PLUR of 30 digits at most, as migration 019's NUMERIC(30, 0) columns take it. */
const JOURNAL_PLUR = /^(0|[1-9]\d{0,29})$/;

/** The chequebook journal in memory, with migration 019's checks that matter to the service. */
export class InMemoryFundingChequebookStore implements FundingChequebookStore {
  readonly rows = new Map<string, FundingChequebookRow>();
  private locked = false;
  /** How many times the lock was refused to a second taker. */
  lockRefusals = 0;
  /** When set, a taker holds the lock until it resolves before its work runs, so a test can meet it there. */
  lockGate: Promise<void> | null = null;

  async withChequebookLock<T>(work: () => Promise<T>): Promise<ChequebookLockOutcome<T>> {
    if (this.locked) {
      this.lockRefusals += 1;
      return { locked: false };
    }
    this.locked = true;
    try {
      if (this.lockGate) await this.lockGate;
      return { locked: true, result: await work() };
    } finally {
      this.locked = false;
    }
  }

  async hasUnsettled(now: Date): Promise<boolean> {
    return [...this.rows.values()].some((row) => holdsChequebookBulk(row, now.getTime()));
  }

  async openBulkIds(limit: number, now: Date): Promise<string[]> {
    return this.bulkIdsWhere((row) => holdsChequebookBulk(row, now.getTime()), limit);
  }

  async askedBulkIds(limit: number): Promise<string[]> {
    return this.bulkIdsWhere(isChequebookAsked, limit);
  }

  /** The bulks with a row that matches, the latest first, as the SQL orders them by their rows' moment. */
  private bulkIdsWhere(matches: (row: FundingChequebookRow) => boolean, limit: number): string[] {
    const latest = new Map<string, number>();
    for (const row of this.rows.values()) {
      if (!matches(row)) continue;
      latest.set(row.bulkId, Math.max(latest.get(row.bulkId) ?? 0, row.createdAt.getTime()));
    }
    return [...latest]
      .sort(([a, at], [b, bt]) => bt - at || a.localeCompare(b))
      .slice(0, limit)
      .map(([bulkId]) => bulkId);
  }

  async insertAll(items: readonly NewFundingChequebookOperation[]): Promise<void> {
    // The database's clock, as the SQL's NOW() writes it.
    const at = new Date();
    const all = [...this.rows.values(), ...items];
    for (const item of items) {
      if (this.rows.has(item.requestId)) throw new Error(`duplicate request id ${item.requestId}`);
      const sameBulk = all.filter((other) => other !== item && other.bulkId === item.bulkId);
      if (sameBulk.some((other) => other.nodeId === item.nodeId)) throw new Error('one_per_node');
      if (sameBulk.some((other) => other.position === item.position)) throw new Error('bulk_position');
      for (const plur of [item.amountPlur, item.targetPlur, item.availablePlur]) {
        if (!JOURNAL_PLUR.test(plur)) throw new Error(`numeric field overflow: ${item.requestId}`);
      }
      const [amount, target, available] = [item.amountPlur, item.targetPlur, item.availablePlur].map(BigInt);
      const move =
        (item.direction === 'deposit' && amount === target - available) ||
        (item.direction === 'withdraw' && amount === available - target);
      if (amount <= 0n || target < 10n ** 16n || !move) {
        throw new Error(`funding_chequebook_operations CHECK: ${item.requestId}`);
      }
    }
    for (const item of items) {
      this.rows.set(item.requestId, {
        ...item,
        state: 'queued',
        txHash: null,
        error: null,
        // Migration 020's default.
        mined: false,
        relayedAt: null,
        createdAt: at,
        updatedAt: at,
      });
    }
  }

  async listBulk(bulkId: string): Promise<FundingChequebookRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.bulkId === bulkId)
      .sort((a, b) => a.position - b.position)
      .map((row) => ({ ...row }));
  }

  async update(requestId: string, update: FundingChequebookUpdate): Promise<FundingChequebookRow | null> {
    const row = this.rows.get(requestId);
    if (!row || !isChequebookAsked(row)) return null;
    const next: FundingChequebookRow = {
      ...row,
      state: update.state,
      error: update.error,
      txHash: update.txHash ?? row.txHash,
      mined: update.mined ?? row.mined,
      relayedAt: update.relayedAt ?? row.relayedAt,
      updatedAt: new Date(),
    };
    this.rows.set(requestId, next);
    return { ...next };
  }

  /** A row as stored, for a test to read. */
  get(requestId: string): FundingChequebookRow | undefined {
    const row = this.rows.get(requestId);
    return row ? { ...row } : undefined;
  }

  /** Sets a row's state outside the service, as an earlier request would have left it. */
  force(
    requestId: string,
    state: FundingChequebookRow['state'],
    over: Partial<Pick<FundingChequebookRow, 'error' | 'txHash' | 'mined' | 'relayedAt' | 'createdAt'>> = {},
  ): void {
    const row = this.rows.get(requestId);
    if (!row) throw new Error(`no such row: ${requestId}`);
    this.rows.set(requestId, { ...row, state, ...over });
  }
}
