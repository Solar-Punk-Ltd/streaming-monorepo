/**
 * The funding service against fakes: the brand wallet signs for real with a key generated here, the manager journals
 * what it is relayed, and the journal and the pins are in memory. `pnpm test`.
 *
 * Pinned here: the Funding page's view and its pin states; the refusals of a send and their order; the balance check
 * with the fees counted, to the wei; consecutive nonces and the transactions themselves; that every item is journalled
 * with its signed bytes before any relay; that a refresh relays again exactly the journalled bytes under the same
 * request id, and never sends a failed item again; one send at a time; and that no audit row carries the password, a
 * signed transaction or the key.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { FundingTransferItemRequest } from '@streaming-monorepo/web2-admin-common';
import { encodeFunctionData, erc20Abi, getAddress, type Hex, keccak256, parseTransaction } from 'viem';

import { RequestShapeError } from '../../src/domain/errors/index.js';
import {
  FundingBusyError,
  FundingManagerUnavailableError,
  FundingRefusedError,
} from '../../src/domain/errors/index.js';
import { FUNDING_SYSTEM, FundingService } from '../../src/domain/funding/FundingService.js';
import { FundingStampService } from '../../src/domain/funding/FundingStampService.js';

import { TEST_OPERATOR, InMemoryAuditLog } from './support/fakes.js';
import {
  BATCH_CATALOGUE,
  BZZ_TOKEN,
  DAY,
  FakeFundingManager,
  FakeFundingWallet,
  fundingAccount,
  fundingBatch,
  fundingInventory,
  fundingNode,
  InMemoryFundingPinStore,
  InMemoryFundingStampStore,
  managerFailure,
  InMemoryFundingTransferStore,
  NODE_A,
  NODE_B,
  NODE_CATALOGUE,
  ONE_XBZZ,
  ONE_XDAI,
  POSTAGE,
  WALLET_A,
  WALLET_B,
  WALLET_C,
} from './support/fundingFakes.js';

let wallet: FakeFundingWallet;
let manager: FakeFundingManager;
let transfers: InMemoryFundingTransferStore;
let pins: InMemoryFundingPinStore;
let stampJournal: InMemoryFundingStampStore;
let audit: InMemoryAuditLog;
let service: FundingService;
/** The service's clock, which a test moves by hand. */
const clock = { now: 0 };

function build(over: { wallet?: FakeFundingWallet | null; manager?: FakeFundingManager | null } = {}): FundingService {
  const builtManager = over.manager === undefined ? manager : over.manager;
  return new FundingService({
    wallet: over.wallet === undefined ? wallet : over.wallet,
    manager: builtManager,
    transfers,
    pins,
    stamps: new FundingStampService({ manager: builtManager, journal: stampJournal, audit, now: () => clock.now }),
    audit,
    now: () => clock.now,
  });
}

beforeEach(() => {
  clock.now = Date.parse('2026-10-05T12:00:00.000Z');
  wallet = new FakeFundingWallet();
  manager = new FakeFundingManager();
  transfers = new InMemoryFundingTransferStore();
  pins = new InMemoryFundingPinStore();
  stampJournal = new InMemoryFundingStampStore();
  audit = new InMemoryAuditLog();
  service = build();
});

/** Pins every node of the default inventory at the address it answers. */
function pinAll(): void {
  pins.set(NODE_A, WALLET_A);
  pins.set(NODE_B, WALLET_B);
  pins.set(NODE_CATALOGUE, WALLET_C);
}

const xdai = (nodeId: string, amount: bigint | string): FundingTransferItemRequest => ({
  nodeId,
  kind: 'xdai',
  amount: amount.toString(),
});
const xbzz = (nodeId: string, amount: bigint | string): FundingTransferItemRequest => ({
  nodeId,
  kind: 'xbzz',
  amount: amount.toString(),
});

/** What the default account charges per item in fees: its gas limit at the 2 gwei fee cap. */
const FEE_XDAI = 21_000n * 2_000_000_000n;
const FEE_XBZZ = 60_000n * 2_000_000_000n;

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected a refusal');
}

describe('the Funding page view', () => {
  it('asks the manager nothing while funding is not set up', async () => {
    const view = await build({ manager: null }).view();

    assert.equal(view.configured, false);
    assert.deepEqual(view.wallet, { address: wallet.address(), xdaiWei: null, xbzzPlur: null });
    assert.equal(view.chainId, 100);
    assert.deepEqual(view.stages, []);
    assert.equal(view.catalogue, null);
    assert.equal(view.observedAt, null);
    assert.equal(view.managerError, null);
    assert.deepEqual(manager.calls, { inventory: 0, account: 0, relay: 0, status: 0 });
  });

  it('shows no wallet while there is none, and asks for no account', async () => {
    wallet.present = false;
    const view = await service.view();

    assert.equal(view.wallet, null);
    assert.equal(view.configured, true);
    assert.equal(manager.calls.account, 0);
    assert.equal(view.stages.length, 1);
  });

  it('answers the balances, the nodes and each node against its pin', async () => {
    pins.set(NODE_A, WALLET_A);
    pins.set(NODE_CATALOGUE, WALLET_B);
    const view = await service.view();

    assert.deepEqual(view.wallet, {
      address: wallet.address(),
      xdaiWei: (10n * ONE_XDAI).toString(),
      xbzzPlur: (100n * ONE_XBZZ).toString(),
    });
    assert.equal(view.observedAt, '2026-10-05T10:00:00.000Z');
    assert.equal(view.managerError, null);
    const [stage] = view.stages;
    assert.ok(stage);
    assert.deepEqual(
      stage.nodes.map((node) => [node.nodeId, node.pin, node.pinnedAddress]),
      [
        [NODE_A, 'pinned', WALLET_A],
        [NODE_B, 'new', null],
      ],
    );
    assert.equal(view.catalogue?.pin, 'changed');
    assert.equal(view.catalogue?.pinnedAddress, WALLET_B);
    assert.equal(view.catalogue?.walletAddress, WALLET_C);
  });

  it('says why in a sentence when the manager cannot be read, never its address or token', async () => {
    manager.inventoryError = managerFailure(
      'unreachable',
      null,
      'The manager could not be reached for GET http://manager.example:9876/api/admin-funding/inventory with secret-token-0123456789abcdef.',
    );
    const view = await service.view();

    assert.equal(view.configured, true);
    assert.equal(view.managerError, 'The manager could not be reached.');
    assert.deepEqual(view.wallet, { address: wallet.address(), xdaiWei: null, xbzzPlur: null });
    assert.deepEqual(view.stages, []);
    assert.equal(view.catalogue, null);
    assert.equal(view.postage, null);
    assert.equal(view.observedAt, null);
    assert.doesNotMatch(JSON.stringify(view), /manager\.example|secret-token/);
  });

  it("answers each node's batch and the price of postage as the manager read them", async () => {
    const stageBatch = fundingBatch();
    const unread = {
      ...fundingBatch({ batchId: BATCH_CATALOGUE }),
      depth: null,
      immutable: null,
      usable: null,
      ttlSeconds: null,
      fillRatio: null,
      readError: 'The node did not answer about the batch.',
    };
    const inventory = fundingInventory();
    inventory.chain.postage = POSTAGE;
    inventory.stages[0]!.nodes[0]!.batch = stageBatch;
    inventory.stages[0]!.nodes[1]!.batch = null;
    inventory.catalogue!.batch = unread;
    manager.inventoryAnswer = inventory;

    const view = await service.view();

    assert.deepEqual(view.postage, POSTAGE);
    assert.deepEqual(
      view.stages[0]?.nodes.map((node) => node.batch),
      [stageBatch, null],
    );
    assert.deepEqual(view.catalogue?.batch, unread);
    assert.equal(view.stages[0]?.nodes[0]?.batch?.ttlSeconds, 10 * DAY);
  });

  it('answers no batch and no price from a manager that reads neither', async () => {
    const view = await service.view();

    assert.equal(view.postage, null);
    assert.deepEqual(
      [...(view.stages[0]?.nodes ?? []), view.catalogue].map((node) => node?.batch ?? null),
      [null, null, null],
    );
  });

  it('leaves the batch out of a node the manager answered without one, as a manager older than the Stamps tab does', async () => {
    const inventory = fundingInventory();
    // The gateway is named with no batch, as a manager that reads batches names a node that has none.
    inventory.stages[0]!.nodes[1]!.batch = null;
    manager.inventoryAnswer = inventory;

    const view = await service.view();

    const [uploader, gateway] = view.stages[0]?.nodes ?? [];
    assert.ok(uploader && gateway && view.catalogue);
    assert.equal('batch' in uploader, false, 'answered without a batch, it has none: not even a null');
    assert.equal('batch' in view.catalogue, false);
    assert.equal(gateway.batch, null, 'named with none, it keeps its null');
  });

  it('answers no price from a manager on another chain', async () => {
    manager.inventoryAnswer = fundingInventory({ chain: { chainId: 1, bzzToken: BZZ_TOKEN, postage: POSTAGE } });

    const view = await service.view();

    assert.match(view.managerError ?? '', /chain 1/);
    assert.equal(view.postage, null);
    assert.deepEqual(view.stages, []);
  });

  it('reads the balances as unknown when the account alone cannot be read', async () => {
    manager.accountError = managerFailure('chain_unreachable', 502);
    const view = await service.view();

    assert.equal(view.managerError, 'The manager could not reach the chain.');
    assert.equal(view.wallet?.xdaiWei, null);
    assert.equal(view.wallet?.xbzzPlur, null);
    assert.equal(view.observedAt, null);
  });
});

describe('pinning node wallets', () => {
  it('pins the address each node answers now, and the view shows it pinned', async () => {
    const answer = await service.pin(TEST_OPERATOR, [NODE_A, NODE_CATALOGUE, NODE_A]);

    assert.deepEqual(answer, { pinned: [NODE_A, NODE_CATALOGUE] });
    assert.equal(pins.rows.get(NODE_A)?.walletAddress, WALLET_A);
    assert.equal(pins.rows.get(NODE_A)?.pinnedBy, TEST_OPERATOR.username);
    const view = await service.view();
    assert.equal(view.stages[0]?.nodes[0]?.pin, 'pinned');
    assert.equal(view.catalogue?.pin, 'pinned');
  });

  it('pins a changed node again at its new address, and audits both addresses', async () => {
    pins.set(NODE_A, WALLET_B);
    assert.equal((await service.view()).stages[0]?.nodes[0]?.pin, 'changed');

    await service.pin(TEST_OPERATOR, [NODE_A]);

    assert.equal(pins.rows.get(NODE_A)?.walletAddress, WALLET_A);
    const [entry] = audit.withAction('funding.pin');
    assert.ok(entry);
    assert.deepEqual(entry.actor, TEST_OPERATOR);
    assert.deepEqual(entry.details, {
      pins: [{ nodeId: NODE_A, nodeLabel: 'Main stage uploader', walletAddress: WALLET_A, previousAddress: WALLET_B }],
    });
  });

  it('refuses a node the manager does not hold, and pins nothing', async () => {
    const error = await refusal(service.pin(TEST_OPERATOR, [NODE_A, 'stage-9:nowhere']));

    assert.ok(error instanceof FundingRefusedError);
    assert.equal(error.problem, 'node');
    assert.match(error.message, /no node stage-9:nowhere/);
    assert.equal(pins.rows.size, 0);
  });

  it('refuses a node whose wallet could not be read as a bad request, with nothing to pin', async () => {
    manager.inventoryAnswer = fundingInventory({
      catalogue: fundingNode({ nodeId: NODE_CATALOGUE, label: 'Catalogue node', walletAddress: null }),
    });
    const error = await refusal(service.pin(TEST_OPERATOR, [NODE_CATALOGUE]));

    assert.ok(error instanceof RequestShapeError);
    assert.match(error.problems[0] ?? '', /Catalogue node \(catalogue:uploader\) could not be read/);
    assert.equal(pins.rows.size, 0);
  });

  it('refuses while funding is not set up', async () => {
    const error = await refusal(build({ manager: null }).pin(TEST_OPERATOR, [NODE_A]));

    assert.ok(error instanceof FundingRefusedError);
    assert.equal(error.problem, 'not_set_up');
  });
});

describe('refusing a send, in order', () => {
  it('refuses a node named twice for one kind before it asks the manager anything', async () => {
    const error = await refusal(service.send(TEST_OPERATOR, [xdai(NODE_A, 1n), xbzz(NODE_A, 1n), xdai(NODE_A, 2n)]));

    assert.ok(error instanceof RequestShapeError);
    assert.match(error.problems[0] ?? '', /stage-1:uploader is named twice for xDAI/);
    assert.equal(manager.calls.inventory, 0);
  });

  it('takes one node for both kinds', async () => {
    pinAll();
    const answer = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n), xbzz(NODE_A, 1n)]);

    assert.equal(answer.items.length, 2);
  });

  it('refuses a node never pinned', async () => {
    pins.set(NODE_A, WALLET_A);
    const error = await refusal(service.send(TEST_OPERATOR, [xdai(NODE_A, 1n), xdai(NODE_B, 1n)]));

    assert.ok(error instanceof FundingRefusedError);
    assert.equal(error.problem, 'node');
    assert.match(error.message, /Main stage gateway \(stage-1:gateway\) is not pinned/);
    assert.equal(transfers.rows.size, 0);
    assert.equal(wallet.signed.length, 0);
  });

  it('refuses a node whose wallet is no longer the pinned one', async () => {
    pins.set(NODE_A, WALLET_B);
    const error = await refusal(service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]));

    assert.ok(error instanceof FundingRefusedError);
    assert.match(error.message, /another wallet than the pinned one/);
  });

  it('refuses a node the manager no longer holds, or whose wallet it could not read', async () => {
    pins.set('stage-9:gone', WALLET_A);
    const gone = await refusal(service.send(TEST_OPERATOR, [xdai('stage-9:gone', 1n)]));
    assert.ok(gone instanceof FundingRefusedError);
    assert.match(gone.message, /no node stage-9:gone/);

    pins.set(NODE_A, WALLET_A);
    manager.inventoryAnswer = fundingInventory({
      stages: [
        {
          stageId: fundingInventory().stages[0]!.stageId,
          name: 'Main stage',
          nodes: [fundingNode({ walletAddress: null })],
        },
      ],
    });
    const unreadable = await refusal(service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]));
    assert.ok(unreadable instanceof FundingRefusedError);
    assert.equal(unreadable.problem, 'node');
    assert.match(unreadable.message, /its address could not be read, so it cannot be checked against the pin/);
  });

  it('refuses a node not pinned before an earlier send that is not settled', async () => {
    pinAll();
    await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    pins.rows.delete(NODE_B);

    const error = await refusal(service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]));

    assert.ok(error instanceof FundingRefusedError);
    assert.equal(error.problem, 'node');
  });

  it('refuses while an earlier send has an item that is not settled', async () => {
    pinAll();
    const first = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    for (const state of ['queued', 'submitted'] as const) {
      transfers.force(first.items[0]!.requestId, state);
      const error = await refusal(service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]));
      assert.ok(error instanceof FundingBusyError, state);
    }
    assert.equal(manager.calls.account, 1, 'the account is not read for a refused send');
  });

  it('takes a new send once every earlier item settled, confirmed or failed', async () => {
    pinAll();
    const first = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n), xdai(NODE_B, 1n)]);
    transfers.force(first.items[0]!.requestId, 'confirmed');
    transfers.force(first.items[1]!.requestId, 'failed');

    const second = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);

    assert.equal(second.items.length, 1);
  });

  it('refuses an unsettled earlier send before it reads the balance', async () => {
    pinAll();
    await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    const error = await refusal(service.send(TEST_OPERATOR, [xdai(NODE_B, 1000n * ONE_XDAI)]));

    assert.ok(error instanceof FundingBusyError);
  });

  it('refuses while funding is not set up, or there is no brand wallet', async () => {
    pinAll();
    const off = await refusal(build({ manager: null }).send(TEST_OPERATOR, [xdai(NODE_A, 1n)]));
    assert.ok(off instanceof FundingRefusedError);
    assert.equal(off.problem, 'not_set_up');

    wallet.present = false;
    const none = await refusal(service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]));
    assert.ok(none instanceof FundingRefusedError);
    assert.equal(none.problem, 'not_set_up');
    assert.match(none.message, /no brand wallet/);
  });

  it('refuses a manager on another chain', async () => {
    pinAll();
    manager.inventoryAnswer = fundingInventory({ chain: { chainId: 1, bzzToken: BZZ_TOKEN } });
    const error = await refusal(service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]));

    assert.ok(error instanceof FundingRefusedError);
    assert.equal(error.problem, 'chain');
  });

  it('answers a manager it cannot read with a sentence of its own, nothing signed', async () => {
    pinAll();
    manager.accountError = managerFailure('timeout', null, 'GET http://manager.example/ timed out');
    const error = await refusal(service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]));

    assert.ok(error instanceof FundingManagerUnavailableError);
    assert.equal(error.message, 'The manager could not be reached. Nothing was sent.');
    assert.equal(wallet.signed.length, 0);
    assert.equal(transfers.rows.size, 0);
  });
});

describe('the balance, with the fees', () => {
  beforeEach(pinAll);

  /** The xDAI a send of these items costs, fees included, under the default account. */
  const exactly = (sent: bigint, xdaiItems: number, xbzzItems: number) =>
    sent + BigInt(xdaiItems) * FEE_XDAI + BigInt(xbzzItems) * FEE_XBZZ;

  it('takes a send that fits the balance to the wei', async () => {
    const items = [xdai(NODE_A, ONE_XDAI), xbzz(NODE_A, 5n * ONE_XBZZ), xdai(NODE_B, 2n * ONE_XDAI)];
    manager.accountAnswer = (address) =>
      fundingAccount(address, {
        xdaiWei: exactly(3n * ONE_XDAI, 2, 1).toString(),
        xbzzPlur: (5n * ONE_XBZZ).toString(),
      });

    const answer = await service.send(TEST_OPERATOR, items);

    assert.equal(answer.items.length, 3);
  });

  it('refuses one wei short, naming the shortfall in xDAI', async () => {
    manager.accountAnswer = (address) =>
      fundingAccount(address, { xdaiWei: (exactly(ONE_XDAI, 1, 1) - 1n).toString() });

    const error = await refusal(service.send(TEST_OPERATOR, [xdai(NODE_A, ONE_XDAI), xbzz(NODE_B, ONE_XBZZ)]));

    assert.ok(error instanceof FundingRefusedError);
    assert.equal(error.problem, 'insufficient_funds');
    assert.equal(
      error.message,
      'The brand wallet cannot pay for this send: 0.000000000000000001 xDAI short: it needs 1.000162 xDAI with the fees, and the wallet holds 1.000161999999999999. Nothing was sent.',
    );
    assert.equal(wallet.signed.length, 0);
    assert.equal(transfers.rows.size, 0);
  });

  it('counts the fees of xBZZ items in xDAI, and refuses one PLUR short in xBZZ', async () => {
    manager.accountAnswer = (address) =>
      fundingAccount(address, { xdaiWei: (FEE_XBZZ - 1n).toString(), xbzzPlur: (ONE_XBZZ - 1n).toString() });

    const error = await refusal(service.send(TEST_OPERATOR, [xbzz(NODE_A, ONE_XBZZ)]));

    assert.ok(error instanceof FundingRefusedError);
    assert.match(error.message, /0\.000000000000000001 xDAI short/);
    assert.match(
      error.message,
      /0\.0000000000000001 xBZZ short: it needs 1 xBZZ, and the wallet holds 0\.9999999999999999/,
    );
  });
});

describe('signing, journalling and relaying a send', () => {
  beforeEach(pinAll);

  it('signs each item with consecutive nonces from the pending one, as the transfer it names', async () => {
    const answer = await service.send(TEST_OPERATOR, [
      xdai(NODE_A, ONE_XDAI),
      xbzz(NODE_B, 3n * ONE_XBZZ),
      xdai(NODE_CATALOGUE, 5n),
    ]);

    const rows = await transfers.listBulk(answer.bulkId);
    const parsed = rows.map((row) => parseTransaction(row.rawTransaction as Hex));
    assert.deepEqual(
      parsed.map((tx) => tx.nonce),
      [7, 8, 9],
    );
    for (const tx of parsed) {
      assert.equal(tx.type, 'eip1559');
      assert.equal(tx.chainId, 100);
      assert.equal(tx.maxFeePerGas, 2_000_000_000n);
      assert.equal(tx.maxPriorityFeePerGas, 1_000_000_000n);
    }
    const [first, second, third] = parsed;
    assert.equal(first?.to?.toLowerCase(), WALLET_A);
    assert.equal(first?.value, ONE_XDAI);
    assert.equal(first?.data ?? '0x', '0x');
    assert.equal(first?.gas, 21_000n);
    assert.equal(second?.to?.toLowerCase(), BZZ_TOKEN);
    assert.equal(second?.value ?? 0n, 0n);
    assert.equal(
      second?.data,
      encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(WALLET_B), 3n * ONE_XBZZ] }),
    );
    assert.equal(second?.gas, 60_000n);
    assert.equal(third?.to?.toLowerCase(), WALLET_C);
    assert.equal(third?.value, 5n);
    assert.deepEqual(
      rows.map((row) => row.txHash),
      rows.map((row) => keccak256(row.rawTransaction as Hex)),
    );
  });

  it('journals every item with its signed bytes before relaying any', async () => {
    const seen: string[] = [];
    manager.onRelay = (transfer) => {
      // At the moment of each relay, every item of the send is journalled, this one with these exact bytes.
      assert.equal(transfers.rows.size, 2);
      const row = transfers.get(transfer.requestId);
      assert.ok(row, 'the item is journalled before it is relayed');
      assert.equal(row.rawTransaction, transfer.rawTransaction);
      assert.equal(row.state, 'queued');
      seen.push(transfer.requestId);
    };

    const answer = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n), xbzz(NODE_A, 1n)]);

    assert.deepEqual(
      seen,
      answer.items.map((item) => item.requestId),
    );
    assert.deepEqual(
      manager.relays.map((relay) => [relay.nodeId, relay.kind, relay.to, relay.amount]),
      [
        [NODE_A, 'xdai', WALLET_A, '1'],
        [NODE_A, 'xbzz', WALLET_A, '1'],
      ],
    );
  });

  it('answers the bulk id and every item as the manager answered it, and never the signed bytes', async () => {
    const answer = await service.send(TEST_OPERATOR, [xdai(NODE_A, 10n), xbzz(NODE_B, 20n)]);

    assert.match(answer.bulkId, /^[0-9a-f-]{36}$/);
    assert.equal(answer.items.length, 2);
    for (const item of answer.items) {
      assert.deepEqual(Object.keys(item).sort(), [
        'amount',
        'blockNumber',
        'error',
        'kind',
        'nodeId',
        'requestId',
        'settled',
        'state',
        'txHash',
        'watched',
      ]);
      assert.equal(item.state, 'submitted');
      assert.equal(item.blockNumber, null);
      assert.equal(item.error, null);
    }
    const text = JSON.stringify(answer);
    for (const row of transfers.rows.values()) assert.ok(!text.includes(row.rawTransaction.slice(2)));
  });

  it('leaves an item queued, and the ones after it unrelayed, when the manager cannot be reached', async () => {
    manager.relayErrors.set(1, managerFailure('unreachable', null));
    const answer = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n), xdai(NODE_B, 1n), xdai(NODE_CATALOGUE, 1n)]);

    assert.deepEqual(
      answer.items.map((item) => item.state),
      ['submitted', 'queued', 'queued'],
    );
    assert.equal(manager.calls.relay, 2);
  });

  it('fails an item the manager refuses for good, and the ones after it unsent', async () => {
    manager.relayErrors.set(0, managerFailure('bad_transaction', 422, 'The gas limit is too high.'));
    const answer = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n), xdai(NODE_B, 1n)]);

    assert.deepEqual(
      answer.items.map((item) => [item.state, item.error]),
      [
        ['failed', 'The manager refused it: The gas limit is too high.'],
        [
          'failed',
          'Not sent: a transfer before it in this send failed or was lost, so its nonce might never be reached. Send it again.',
        ],
      ],
    );
    assert.equal(manager.calls.relay, 1);
  });
});

describe('refreshing a send', () => {
  beforeEach(pinAll);

  it('relays an item the manager never received again: the journalled bytes, under the same request id', async () => {
    manager.relayErrorAlways = managerFailure('timeout', null);
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n), xbzz(NODE_B, 2n)]);
    assert.deepEqual(
      sent.items.map((item) => item.state),
      ['queued', 'queued'],
    );
    const journalled = await transfers.listBulk(sent.bulkId);
    const firstAttempt = manager.relays[0];
    const signatures = wallet.signed.length;

    manager.relayErrorAlways = null;
    const refreshed = await service.bulk(sent.bulkId);

    assert.deepEqual(
      refreshed.items.map((item) => item.state),
      ['submitted', 'submitted'],
    );
    const again = manager.relays.slice(1);
    assert.deepEqual(
      again.map((relay) => [relay.requestId, relay.rawTransaction]),
      journalled.map((row) => [row.requestId, row.rawTransaction]),
    );
    assert.equal(again[0]?.rawTransaction, firstAttempt?.rawTransaction);
    assert.equal(wallet.signed.length, signatures, 'nothing is signed again');
  });

  it('records what the manager answers for an item it holds, and settles it as the system', async () => {
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n), xdai(NODE_B, 1n)]);
    const [first, second] = sent.items;
    manager.statusAnswers.set(first!.requestId, { state: 'confirmed', blockNumber: 12 });
    manager.statusAnswers.set(second!.requestId, {
      state: 'failed',
      blockNumber: 12,
      error: 'The transaction reverted on chain.',
    });

    const refreshed = await service.bulk(sent.bulkId);

    assert.deepEqual(
      refreshed.items.map((item) => [item.state, item.error]),
      [
        ['confirmed', null],
        ['failed', 'The transaction reverted on chain.'],
      ],
    );
    assert.equal(transfers.get(first!.requestId)?.blockNumber, 12);
    const [confirmed] = audit.withAction('funding.transfer.confirmed');
    const [failed] = audit.withAction('funding.transfer.failed');
    assert.deepEqual(confirmed?.actor, FUNDING_SYSTEM);
    assert.deepEqual(failed?.actor, FUNDING_SYSTEM);
    assert.equal(confirmed?.details?.amount, '1');
    assert.equal(confirmed?.details?.nodeLabel, 'Main stage uploader');
  });

  it('never asks about or sends a failed item again', async () => {
    manager.relayErrors.set(0, managerFailure('unknown_node', 404, 'No node of this manager has this id.'));
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n), xdai(NODE_B, 1n)]);
    const relays = manager.calls.relay;

    const refreshed = await service.bulk(sent.bulkId);

    assert.deepEqual(
      refreshed.items.map((item) => item.state),
      ['failed', 'failed'],
    );
    assert.equal(manager.calls.status, 0);
    assert.equal(manager.calls.relay, relays);
  });

  it('fails, unsent, an item the manager never received once one before it failed', async () => {
    manager.relayErrorAlways = managerFailure('unreachable', null);
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n), xdai(NODE_B, 1n)]);
    manager.relayErrorAlways = null;
    manager.relayErrors.set(manager.calls.relay, managerFailure('bad_transaction', 422, 'Refused.'));

    const refreshed = await service.bulk(sent.bulkId);

    assert.deepEqual(
      refreshed.items.map((item) => item.state),
      ['failed', 'failed'],
    );
    assert.equal(manager.relays.filter((relay) => relay.requestId === sent.items[1]!.requestId).length, 0);
  });

  it('relays nothing again when the status read refuses the node rather than the request id', async () => {
    manager.relayErrorAlways = managerFailure('timeout', null);
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    manager.relayErrorAlways = null;
    manager.statusError = managerFailure('unknown_node', 404, 'No node of this manager has this id.');
    const relays = manager.calls.relay;

    const refreshed = await service.bulk(sent.bulkId);

    assert.equal(manager.calls.relay, relays, 'only unknown_request says the relay never reached the manager');
    assert.equal(refreshed.items[0]?.state, 'queued');
  });

  it("reads an error that only looks like the manager client's as no answer at all", async () => {
    manager.relayErrorAlways = managerFailure('timeout', null);
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    manager.relayErrorAlways = null;
    manager.statusError = Object.assign(new Error('not the client'), { code: 'unknown_request', status: 404 });
    const relays = manager.calls.relay;

    await service.bulk(sent.bulkId);

    assert.equal(manager.calls.relay, relays);
  });

  it('leaves every item as journalled when the manager cannot be reached', async () => {
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    manager.statusError = managerFailure('unreachable', null);

    const refreshed = await service.bulk(sent.bulkId);

    assert.deepEqual(
      refreshed.items.map((item) => item.state),
      ['submitted'],
    );
  });

  it('answers a send as stored while funding is not set up', async () => {
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    const statusReads = manager.calls.status;

    const refreshed = await build({ manager: null }).bulk(sent.bulkId);

    assert.equal(refreshed.items.length, 1);
    assert.equal(manager.calls.status, statusReads);
  });
});

describe('one send at a time', () => {
  beforeEach(pinAll);

  it('lets exactly one of two sends at once through, and refuses the other as a conflict', async () => {
    let release!: () => void;
    manager.accountGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const both = Promise.allSettled([
      service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]),
      service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]),
    ]);
    // Both are past the pins by now; one holds the lock while it waits for the account.
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const outcomes = await both;

    const passed = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(passed.length, 1);
    assert.equal(refused.length, 1);
    assert.ok((refused[0] as PromiseRejectedResult).reason instanceof FundingBusyError);
    assert.equal(transfers.lockRefusals, 1, 'the second was refused at the lock, not after the first finished');
    assert.equal(transfers.rows.size, 1);
    assert.equal(wallet.signed.length, 1);
  });
});

describe('the audit log of a send', () => {
  beforeEach(pinAll);

  it('records the request, each send and each settlement, with the operator, the amounts and the labels', async () => {
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 10n), xbzz(NODE_B, 20n)]);

    const [request] = audit.withAction('funding.transfer.request');
    assert.deepEqual(request?.actor, TEST_OPERATOR);
    assert.equal(request?.details?.bulkId, sent.bulkId);
    const sends = audit.withAction('funding.transfer.sent');
    assert.equal(sends.length, 2);
    assert.deepEqual(
      sends.map((entry) => [entry.actor, entry.details?.nodeLabel, entry.details?.amount, entry.details?.kind]),
      [
        [TEST_OPERATOR, 'Main stage uploader', '10', 'xdai'],
        [TEST_OPERATOR, 'Main stage gateway', '20', 'xbzz'],
      ],
    );
  });

  it('never carries the password, a signed transaction or the key', async () => {
    manager.relayErrors.set(1, managerFailure('bad_transaction', 422, 'Refused.'));
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 10n), xbzz(NODE_B, 20n), xdai(NODE_CATALOGUE, 1n)]);
    await service.pin(TEST_OPERATOR, [NODE_A]);
    manager.statusAnswers.set(sent.items[0]!.requestId, { state: 'confirmed', blockNumber: 3 });
    await service.bulk(sent.bulkId);

    const text = JSON.stringify(audit.entries).toLowerCase();
    assert.ok(audit.entries.length >= 6);
    assert.doesNotMatch(text, /rawtransaction|raw_transaction|password/);
    assert.ok(!text.includes(wallet.privateKey.slice(2).toLowerCase()));
    for (const row of transfers.rows.values()) {
      assert.ok(!text.includes(row.rawTransaction.slice(2)), 'no signed transaction');
    }
  });
});

describe("the admin's own fee and gas ceilings", () => {
  beforeEach(pinAll);

  const GWEI = 1_000_000_000n;

  async function refusedFor(over: Parameters<typeof fundingAccount>[1], items: FundingTransferItemRequest[]) {
    manager.accountAnswer = (address) => fundingAccount(address, over);
    return refusal(service.send(TEST_OPERATOR, items));
  }

  it('signs at a fee cap of 100 gwei, and refuses one wei over it, nothing signed', async () => {
    manager.accountAnswer = (address) =>
      fundingAccount(address, { maxFeePerGasWei: (100n * GWEI).toString(), maxPriorityFeePerGasWei: '1' });
    assert.equal((await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)])).items.length, 1);

    transfers.rows.clear();
    const signed = wallet.signed.length;
    const error = await refusedFor({ maxFeePerGasWei: (100n * GWEI + 1n).toString(), maxPriorityFeePerGasWei: '1' }, [
      xdai(NODE_A, 1n),
    ]);

    assert.ok(error instanceof FundingRefusedError);
    assert.equal(error.problem, 'fee');
    assert.match(error.message, /fee cap of 100\.000000001 gwei, over the admin's ceiling of 100 gwei/);
    assert.equal(wallet.signed.length, signed);
    assert.equal(transfers.rows.size, 0);
  });

  it('refuses a priority fee over the fee cap', async () => {
    const error = await refusedFor({ maxFeePerGasWei: '1000', maxPriorityFeePerGasWei: '1001' }, [xdai(NODE_A, 1n)]);

    assert.ok(error instanceof FundingRefusedError);
    assert.equal(error.problem, 'fee');
    assert.match(error.message, /priority fee/);
  });

  it('takes a gas limit of exactly 21000 for xDAI, and nothing else', async () => {
    for (const gasNative of ['20999', '21001', '0']) {
      const error = await refusedFor({ gasNative }, [xdai(NODE_A, 1n)]);
      assert.ok(error instanceof FundingRefusedError, gasNative);
      assert.equal(error.problem, 'fee');
      assert.match(error.message, /gas limit of \d+ for an xDAI transfer/);
    }
    assert.equal(wallet.signed.length, 0);
  });

  it('takes a gas limit of at most 100000 for xBZZ', async () => {
    for (const gasBzzTransfer of ['100001', '0']) {
      const error = await refusedFor({ gasBzzTransfer }, [xbzz(NODE_A, 1n)]);
      assert.ok(error instanceof FundingRefusedError, gasBzzTransfer);
      assert.equal(error.problem, 'fee');
    }
    manager.accountAnswer = (address) => fundingAccount(address, { gasBzzTransfer: '100000', gasNative: '99999' });
    const answer = await service.send(TEST_OPERATOR, [xbzz(NODE_A, 1n)]);

    assert.equal(answer.items.length, 1, 'only the gas of the kinds sent is held to its ceiling');
    assert.equal(wallet.signed[0]?.gas, 100_000n);
  });
});

describe('nodes whose wallet could not be read', () => {
  const unreadableInventory = () =>
    fundingInventory({
      stages: [
        {
          stageId: fundingInventory().stages[0]!.stageId,
          name: 'Main stage',
          nodes: [
            fundingNode({ walletAddress: null, readError: 'The node did not answer.' }),
            fundingNode({
              nodeId: NODE_B,
              label: 'Main stage gateway',
              role: 'gateway',
              walletAddress: null,
              readError: 'The node did not answer.',
            }),
          ],
        },
      ],
    });

  it('keep their pin state, pinned or new, never changed, and show why', async () => {
    pins.set(NODE_A, WALLET_A);
    manager.inventoryAnswer = unreadableInventory();

    const view = await service.view();

    assert.deepEqual(
      view.stages[0]?.nodes.map((node) => [node.nodeId, node.pin, node.pinnedAddress, node.readError]),
      [
        [NODE_A, 'pinned', WALLET_A, 'The node did not answer.'],
        [NODE_B, 'new', null, 'The node did not answer.'],
      ],
    );
  });

  it('take no send, even when pinned', async () => {
    pins.set(NODE_A, WALLET_A);
    manager.inventoryAnswer = unreadableInventory();

    const error = await refusal(service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]));

    assert.ok(error instanceof FundingRefusedError);
    assert.equal(error.problem, 'node');
    assert.equal(
      error.message,
      'Main stage uploader (stage-1:uploader): its address could not be read, so it cannot be checked against the pin. Nothing was sent.',
    );
  });
});

describe('a send is never stuck', () => {
  beforeEach(pinAll);

  it('refreshes the open send before it refuses a new one, and goes ahead once it settled', async () => {
    const first = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    manager.statusAnswers.set(first.items[0]!.requestId, { state: 'confirmed', blockNumber: 5 });

    const second = await service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]);

    assert.equal(second.items.length, 1);
    assert.equal(transfers.get(first.items[0]!.requestId)?.state, 'confirmed');
    assert.deepEqual(audit.withAction('funding.transfer.confirmed')[0]?.actor, FUNDING_SYSTEM);
  });

  it('names the open send on the Funding page, refreshed, until it settles', async () => {
    assert.equal((await service.view()).openBulkId, null);
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    const reads = manager.calls.status;

    const open = await service.view();
    assert.equal(open.openBulkId, sent.bulkId);
    assert.equal(manager.calls.status, reads + 1, 'the view refreshed the open send');

    manager.statusAnswers.set(sent.items[0]!.requestId, { state: 'confirmed', blockNumber: 5 });
    const settled = await service.view();
    assert.equal(settled.openBulkId, null);
    assert.equal(transfers.get(sent.items[0]!.requestId)?.state, 'confirmed');
  });

  it('names the open send without asking the manager while funding is not set up', async () => {
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    const reads = manager.calls.status;

    assert.equal((await build({ manager: null }).view()).openBulkId, sent.bulkId);
    assert.equal(manager.calls.status, reads);
  });
});

describe('settling', () => {
  beforeEach(pinAll);

  it("watches an item the chain's node refused at the relay, without blocking a new send", async () => {
    manager.relayState = 'failed';
    const first = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    const [item] = first.items;
    assert.equal(item?.state, 'failed');
    assert.equal(item?.blockNumber, null);
    assert.equal(
      item?.error,
      "The chain's node refused it when the manager sent it. If it is mined anyway, this row will say so: check the node's balance before sending to it again.",
    );

    manager.relayState = 'submitted';
    const second = await service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]);
    assert.equal(second.items.length, 1);

    // A late receipt: the manager found it mined after all.
    manager.statusAnswers.set(item!.requestId, { state: 'confirmed', blockNumber: 77, error: null });
    const refreshed = await service.bulk(first.bulkId);

    assert.deepEqual(
      refreshed.items.map((one) => [one.state, one.blockNumber, one.error]),
      [['confirmed', 77, null]],
    );
    const confirmed = audit.withAction('funding.transfer.confirmed');
    assert.equal(confirmed.length, 1);
    assert.deepEqual(confirmed[0]?.actor, FUNDING_SYSTEM);

    // Settled for good now: never asked about again.
    const reads = manager.calls.status;
    await service.bulk(first.bulkId);
    assert.equal(manager.calls.status, reads);
  });

  it('answers the block of an item mined, confirmed or reverted', async () => {
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n), xdai(NODE_B, 1n)]);
    manager.statusAnswers.set(sent.items[0]!.requestId, { state: 'confirmed', blockNumber: 12 });
    manager.statusAnswers.set(sent.items[1]!.requestId, {
      state: 'failed',
      blockNumber: 13,
      error: 'The transaction reverted on chain.',
    });

    const refreshed = await service.bulk(sent.bulkId);

    assert.deepEqual(
      refreshed.items.map((one) => [one.state, one.blockNumber]),
      [
        ['confirmed', 12],
        ['failed', 13],
      ],
    );
    const reads = manager.calls.status;
    await service.bulk(sent.bulkId);
    assert.equal(manager.calls.status, reads, 'a failure in a block is final');
  });

  it('lets a new send through past an item the manager answers unknown, and keeps watching it', async () => {
    const first = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    const requestId = first.items[0]!.requestId;
    manager.statusAnswers.set(requestId, { state: 'unknown', error: 'The chain has no receipt for it.' });
    assert.equal((await service.bulk(first.bulkId)).items[0]?.state, 'unknown');

    // Unknown for the manager's 30 minutes: the chain no longer holds it, so a new send may reuse its nonce.
    clock.now += 30 * 60 * 1000 + 1;
    const second = await service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]);
    assert.equal(second.items.length, 1);

    manager.statusAnswers.set(requestId, { state: 'confirmed', blockNumber: 9, error: null });
    assert.equal((await service.bulk(first.bulkId)).items[0]?.state, 'confirmed');
  });

  it('never relays a watched item again, whatever the manager says of it', async () => {
    manager.relayState = 'failed';
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    manager.journal.clear();
    const relays = manager.calls.relay;

    await service.bulk(sent.bulkId);

    assert.equal(manager.calls.relay, relays);
    assert.equal(transfers.get(sent.items[0]!.requestId)?.state, 'failed');
  });
});

describe('overlapping refreshes of one send', () => {
  beforeEach(pinAll);

  it('relay once and audit once', async () => {
    manager.relayErrorAlways = managerFailure('timeout', null);
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    manager.relayErrorAlways = null;
    const relays = manager.calls.relay;

    const [a, b] = await Promise.all([service.bulk(sent.bulkId), service.bulk(sent.bulkId)]);

    assert.equal(manager.calls.relay, relays + 1);
    assert.equal(audit.withAction('funding.transfer.sent').length, 1);
    assert.deepEqual(a, b);
    assert.equal(a.items[0]?.state, 'submitted');
  });
});

describe("an unknown item younger than the manager's 30 minutes", () => {
  beforeEach(pinAll);

  const THIRTY_MINUTES = 30 * 60 * 1000;

  it('holds up a new send while the answer of its relay was lost, and lets one through once the window passed', async () => {
    manager.relayState = 'unknown';
    const first = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    const requestId = first.items[0]!.requestId;
    assert.equal(first.items[0]?.state, 'unknown');
    // The manager still cannot tell: it may well sit in the pool at its nonce.
    manager.statusAnswers.set(requestId, { state: 'unknown', error: 'Not confirmed yet.' });
    manager.relayState = 'submitted';

    const refused = await refusal(service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]));
    assert.ok(refused instanceof FundingBusyError);
    clock.now += THIRTY_MINUTES;
    assert.ok((await refusal(service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]))) instanceof FundingBusyError);

    clock.now += 1;
    const second = await service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]);
    assert.equal(second.items.length, 1);
  });

  it('becomes submitted once the manager finds it, and holds up a send until it is confirmed', async () => {
    manager.relayState = 'unknown';
    const first = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    const requestId = first.items[0]!.requestId;
    manager.relayState = 'submitted';
    manager.statusAnswers.set(requestId, { state: 'submitted', error: null });

    assert.ok((await refusal(service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]))) instanceof FundingBusyError);
    assert.equal(transfers.get(requestId)?.state, 'submitted');
    assert.equal(transfers.get(requestId)?.watched, false);
    clock.now += THIRTY_MINUTES + 1;
    assert.ok(
      (await refusal(service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]))) instanceof FundingBusyError,
      'a submitted item holds up a send whatever its age',
    );

    manager.statusAnswers.set(requestId, { state: 'confirmed', blockNumber: 31, error: null });
    const second = await service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]);
    assert.equal(second.items.length, 1);
  });

  it('counts its 30 minutes from when the manager answered the relay, not from the journal', async () => {
    // Journalled at t0 with the manager out of reach: the item stays queued.
    manager.relayErrorAlways = managerFailure('unreachable', null);
    const first = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    const requestId = first.items[0]!.requestId;
    assert.equal(first.items[0]?.state, 'queued');

    // 40 minutes on, the relay lands at last, and the answer of the broadcast is lost: unknown.
    clock.now += 40 * 60 * 1000;
    manager.relayErrorAlways = null;
    manager.relayState = 'unknown';
    const refreshed = await service.bulk(first.bulkId);
    assert.deepEqual(
      refreshed.items.map((item) => [item.state, item.settled, item.watched]),
      [['unknown', false, true]],
    );
    manager.statusAnswers.set(requestId, { state: 'unknown', error: null });
    manager.relayState = 'submitted';

    assert.ok((await refusal(service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]))) instanceof FundingBusyError);
    clock.now += THIRTY_MINUTES;
    assert.ok((await refusal(service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]))) instanceof FundingBusyError);
    clock.now += 1;
    const second = await service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]);
    assert.equal(second.items.length, 1);
  });

  it("settles at once when the manager's 30-minute rule turns a submitted item unknown", async () => {
    const first = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    assert.equal(first.items[0]?.state, 'submitted');
    clock.now += THIRTY_MINUTES + 60_000;
    manager.statusAnswers.set(first.items[0]!.requestId, {
      state: 'unknown',
      error: 'The chain has no receipt for it and no longer holds it.',
    });

    const second = await service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]);

    assert.equal(second.items.length, 1);
    assert.equal(transfers.get(first.items[0]!.requestId)?.state, 'unknown');
  });

  it('counts its 30 minutes from the status read that first finds a relay whose answer timed out', async () => {
    // The relay's answer times out, so the item stays queued; the manager did journal it, and ends up unknown.
    manager.relayErrorAlways = managerFailure('timeout', null);
    const first = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    const requestId = first.items[0]!.requestId;
    transfers.force(requestId, 'queued', { createdAt: new Date(clock.now) });
    manager.relayErrorAlways = null;
    manager.statusAnswers.set(requestId, { state: 'unknown', error: null });

    // The next look is 40 minutes after the journal: counted from the journal, the window would be over already.
    clock.now += 40 * 60 * 1000;
    assert.ok((await refusal(service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]))) instanceof FundingBusyError);
    assert.equal(transfers.get(requestId)?.state, 'unknown');
    assert.equal(transfers.get(requestId)?.relayedAt?.getTime(), clock.now);

    clock.now += THIRTY_MINUTES;
    assert.ok((await refusal(service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]))) instanceof FundingBusyError);
    clock.now += 1;
    const second = await service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]);
    assert.equal(second.items.length, 1);
  });

  it('asks the manager again before letting a send past an aged unknown item, which may be in the pool after all', async () => {
    manager.relayState = 'unknown';
    const first = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    manager.relayState = 'submitted';
    // The manager finds it in the pool; nothing on the page reads it in between.
    manager.statusAnswers.set(first.items[0]!.requestId, { state: 'submitted', error: null });
    clock.now += THIRTY_MINUTES + 60_000;

    assert.ok((await refusal(service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]))) instanceof FundingBusyError);
    assert.equal(transfers.get(first.items[0]!.requestId)?.state, 'submitted');
  });

  it("asks about an item the chain's node refused before a send, and holds the send once the pool holds it", async () => {
    manager.relayState = 'failed';
    const first = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    const requestId = first.items[0]!.requestId;
    assert.deepEqual(
      first.items.map((item) => [item.state, item.settled, item.watched]),
      [['failed', true, true]],
    );
    manager.relayState = 'submitted';
    // The manager finds it in the chain's pool after all: open again.
    manager.statusAnswers.set(requestId, { state: 'submitted', error: null });

    assert.ok((await refusal(service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]))) instanceof FundingBusyError);
    assert.equal(transfers.get(requestId)?.state, 'submitted');
    assert.equal(transfers.get(requestId)?.watched, false);
  });

  it('lets a send past an aged unknown item that the manager still cannot tell', async () => {
    manager.relayState = 'unknown';
    const first = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    manager.relayState = 'submitted';
    manager.statusAnswers.set(first.items[0]!.requestId, { state: 'unknown', error: null });
    clock.now += THIRTY_MINUTES + 60_000;
    const reads = manager.calls.status;

    const second = await service.send(TEST_OPERATOR, [xdai(NODE_B, 1n)]);

    assert.equal(second.items.length, 1);
    assert.equal(manager.calls.status, reads + 1, 'it was asked about first');
  });

  it('names its send as the open one on the Funding page', async () => {
    manager.relayState = 'unknown';
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);
    manager.statusAnswers.set(sent.items[0]!.requestId, { state: 'unknown', error: null });

    assert.equal((await service.view()).openBulkId, sent.bulkId);
    clock.now += THIRTY_MINUTES + 1;
    assert.equal((await service.view()).openBulkId, null);
  });
});

describe('the settled and watched flags of an item', () => {
  it('say for each state whether it holds up a send, and whether it is still watched', async () => {
    const bulkId = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
    const cases = [
      { name: 'queued', state: 'queued', settled: false, watched: false },
      { name: 'submitted', state: 'submitted', settled: false, watched: false },
      { name: 'confirmed', state: 'confirmed', blockNumber: 5, settled: true, watched: false },
      { name: 'failed in a block', state: 'failed', blockNumber: 5, settled: true, watched: false },
      { name: 'failed at the relay', state: 'failed', watchedColumn: true, settled: true, watched: true },
      { name: 'failed, never sent', state: 'failed', settled: true, watched: false },
      { name: 'young unknown', state: 'unknown', watchedColumn: true, settled: false, watched: true },
      {
        name: 'old unknown',
        state: 'unknown',
        watchedColumn: true,
        ageMs: 31 * 60 * 1000,
        settled: true,
        watched: true,
      },
    ] as const;
    await transfers.insertAll(
      cases.map((one, index) => ({
        requestId: `00000000-0000-4000-8000-00000000000${index}`,
        bulkId,
        nodeId: `stage-1:node-${index}`,
        nodeLabel: one.name,
        toAddress: WALLET_A,
        kind: 'xdai' as const,
        amount: '1',
        nonce: index,
        rawTransaction: '0x02',
        txHash: `0x${'ab'.repeat(32)}`,
        requestedByUserId: null,
        requestedBy: 'test-operator',
      })),
    );
    cases.forEach((one, index) =>
      transfers.force(`00000000-0000-4000-8000-00000000000${index}`, one.state, {
        blockNumber: 'blockNumber' in one ? one.blockNumber : null,
        watched: 'watchedColumn' in one,
        // The manager answered its relay this long ago.
        relayedAt: new Date(clock.now - ('ageMs' in one ? one.ageMs : 0)),
      }),
    );

    const { items } = await build({ manager: null }).bulk(bulkId);

    assert.deepEqual(
      items.map((item, index) => [cases[index]?.name, item.settled, item.watched]),
      cases.map((one) => [one.name, one.settled, one.watched]),
    );
  });

  it('are answered by a send as well', async () => {
    pinAll();
    manager.relayState = 'unknown';
    const sent = await service.send(TEST_OPERATOR, [xdai(NODE_A, 1n)]);

    assert.deepEqual(
      sent.items.map((item) => [item.state, item.settled, item.watched]),
      [['unknown', false, true]],
    );
  });
});
