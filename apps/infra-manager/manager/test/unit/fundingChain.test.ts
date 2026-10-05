/**
 * The funding API's chain side: an account's balances, nonce and fees; a signed transfer to a node's wallet, checked,
 * journalled and then broadcast; and a transfer's state, refreshed from its receipt.
 *
 * Unit test, no database and no chain: a fake chain, an in-memory journal and a fake inventory. Every transaction is
 * signed here with a key generated for the run, never a real one. `pnpm test` in manager/.
 *
 * The rules a transfer is held to, each refused as 422 `bad_transaction` with nothing journalled and nothing sent:
 * EIP-1559 only, on Gnosis Chain; for xDAI a plain transfer of exactly the amount to exactly the node's wallet; for
 * xBZZ the BZZ token's `transfer(to, amount)` with no value; no access list; a gas limit and a fee cap within three
 * times the manager's own suggestion.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  concatHex,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  parseSignature,
  serializeTransaction,
  toHex,
  toRlp,
  trim,
  type Hex,
  type TransactionSerializableEIP1559,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import type { FundingInventory, FundingTransferRequest } from '@streaming-monorepo/contracts';

import type { ChainFeeSuggestion, SentTransaction } from '../../src/domain/chequebook/ChainRpc.js';
import type { ChainReceipt, ChainTransaction } from '../../src/domain/chequebook/chainEvidence.js';
import { ChainEvidenceError } from '../../src/domain/errors/ChainEvidenceError.js';
import { ChainReadError } from '../../src/domain/errors/ChainReadError.js';
import { Logger } from '../../src/domain/Logger.js';
import type { FundingTransferRow } from '../../src/domain/funding/FundingTransferJournal.js';
import { FundingApiError } from '../../src/domain/funding/FundingApiError.js';
import {
  FUNDING_GAS_BZZ_TRANSFER,
  FUNDING_GAS_NATIVE,
  FUNDING_UNKNOWN_AFTER_MS,
  type FundingChain,
  FundingChainService,
} from '../../src/domain/funding/FundingChainService.js';
import { FUNDING_BZZ_TOKEN } from '../../src/domain/funding/FundingInventoryService.js';
import { InMemoryFundingTransferJournal } from '../support/InMemoryFundingTransferJournal.js';

const brand = privateKeyToAccount(generatePrivateKey());
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const NODE = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b:bee-uploader';
const REQUEST = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const FEES: ChainFeeSuggestion = { baseFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000000' };
/** Twice the base fee and the tip: 3 gwei. */
const SUGGESTED_MAX_FEE = 3_000_000_000n;
const START = Date.parse('2026-10-05T10:00:00.000Z');

const INVENTORY: FundingInventory = {
  observedAt: '2026-10-05T10:00:00.000Z',
  chain: { chainId: 100, bzzToken: FUNDING_BZZ_TOKEN },
  stages: [
    {
      stageId: '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b',
      name: 'stage-one',
      nodes: [
        {
          nodeId: NODE,
          label: 'stage-one Bee node',
          role: 'uploader',
          walletAddress: WALLET,
          xdaiWei: '0',
          xbzzPlur: '0',
          readError: null,
        },
        {
          nodeId: 'unread:bee-uploader',
          label: 'unread',
          role: 'uploader',
          walletAddress: null,
          xdaiWei: null,
          xbzzPlur: null,
          readError: 'The node could not be reached.',
        },
      ],
    },
  ],
  catalogue: null,
};

class FakeChain implements FundingChain {
  sent: string[] = [];
  sendAnswer: () => Promise<SentTransaction> = async () => ({ kind: 'sent', hash: this.lastHash() });
  receipts = new Map<string, ChainReceipt>();
  pending = new Set<string>();
  down = false;
  /** Answers that are not what a chain answers, which the RPC client throws ChainEvidenceError for. */
  garbled = false;
  /** How many receipts were asked for. */
  receiptReads = 0;
  /** Called at the moment of the broadcast, to look at the journal then. */
  onSend: () => void = () => undefined;

  private lastHash(): string {
    return keccak256(this.sent.at(-1) as Hex);
  }
  private guard(): void {
    if (this.down) throw new ChainReadError();
    if (this.garbled) throw new ChainEvidenceError();
  }
  async balance(): Promise<string> {
    this.guard();
    return '1000000000000000000';
  }
  async tokenBalance(token: string): Promise<string> {
    this.guard();
    assert.equal(token, FUNDING_BZZ_TOKEN);
    return '500000000000000000';
  }
  async pendingNonce(): Promise<number> {
    this.guard();
    return 7;
  }
  async feeSuggestion(): Promise<ChainFeeSuggestion> {
    this.guard();
    return FEES;
  }
  async sendRawTransaction(raw: string): Promise<SentTransaction> {
    this.guard();
    this.sent.push(raw);
    this.onSend();
    return this.sendAnswer();
  }
  async receipt(hash: string): Promise<ChainReceipt | null> {
    this.receiptReads += 1;
    this.guard();
    return this.receipts.get(hash) ?? null;
  }
  async transaction(hash: string): Promise<ChainTransaction | null> {
    this.guard();
    return this.pending.has(hash) ? ({ hash } as ChainTransaction) : null;
  }
}

function setup(options: { chain?: FakeChain | null; journal?: InMemoryFundingTransferJournal } = {}) {
  const chain = options.chain === undefined ? new FakeChain() : options.chain;
  const journal = options.journal ?? new InMemoryFundingTransferJournal();
  let now = START;
  const service = new FundingChainService({
    chain,
    journal,
    inventory: { inventory: async () => INVENTORY },
    now: () => now,
  });
  return { chain: chain as FakeChain, journal, service, advance: (ms: number) => void (now += ms) };
}

/** RLP's integer: no leading zeros, and zero as the empty string. */
const rlpInt = (value: bigint): Hex => (value === 0n ? '0x' : toHex(value));

/**
 * A type 2 transaction signed by the brand key without viem's own checks, for a field viem refuses to sign: a tip
 * above the fee cap.
 */
async function signedUnchecked(tip: bigint, maxFee: bigint): Promise<Hex> {
  const fields: Hex[] = [
    toHex(100),
    toHex(7),
    rlpInt(tip),
    rlpInt(maxFee),
    toHex(21_000),
    WALLET as Hex,
    toHex(10n ** 17n),
    '0x',
  ];
  const unsigned = concatHex(['0x02', toRlp([...fields, []])]);
  const signature = parseSignature(await brand.sign({ hash: keccak256(unsigned) }));
  return concatHex([
    '0x02',
    toRlp([...fields, [], rlpInt(BigInt(signature.yParity ?? 0)), trim(signature.r), trim(signature.s)]),
  ]);
}

async function signed(over: Partial<TransactionSerializableEIP1559> = {}): Promise<Hex> {
  return brand.signTransaction({
    type: 'eip1559',
    chainId: 100,
    nonce: 7,
    to: getAddress(WALLET),
    value: 100_000_000_000_000_000n,
    gas: FUNDING_GAS_NATIVE,
    maxFeePerGas: SUGGESTED_MAX_FEE,
    maxPriorityFeePerGas: 1_000_000_000n,
    ...over,
  });
}

async function bzzSigned(
  over: Partial<TransactionSerializableEIP1559> = {},
  to = WALLET,
  amount = 10n ** 16n,
): Promise<Hex> {
  return signed({
    to: getAddress(FUNDING_BZZ_TOKEN),
    value: 0n,
    gas: FUNDING_GAS_BZZ_TRANSFER,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(to), amount] }),
    ...over,
  });
}

async function xdaiRequest(over: Partial<FundingTransferRequest> = {}, tx?: Hex): Promise<FundingTransferRequest> {
  return {
    requestId: REQUEST,
    nodeId: NODE,
    kind: 'xdai',
    to: WALLET,
    amount: '100000000000000000',
    rawTransaction: tx ?? (await signed()),
    ...over,
  };
}

async function refusedWith(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof FundingApiError, String(err));
    assert.equal(err.code, code);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

describe('GET /api/admin-funding/accounts/:address', () => {
  it('answers the balances, the pending nonce, the fees and the suggested gas limits, on Gnosis Chain', async () => {
    const { service } = setup();
    assert.deepEqual(await service.account(brand.address), {
      address: brand.address.toLowerCase(),
      chainId: 100,
      xdaiWei: '1000000000000000000',
      xbzzPlur: '500000000000000000',
      nonce: 7,
      maxFeePerGasWei: SUGGESTED_MAX_FEE.toString(),
      maxPriorityFeePerGasWei: '1000000000',
      gasNative: FUNDING_GAS_NATIVE.toString(),
      gasBzzTransfer: FUNDING_GAS_BZZ_TRANSFER.toString(),
    });
  });

  it('answers chain_unreachable when the chain does not answer, or the manager has no endpoint for it', async () => {
    const down = setup();
    down.chain.down = true;
    await refusedWith(down.service.account(brand.address), 'chain_unreachable');
    await refusedWith(setup({ chain: null }).service.account(brand.address), 'chain_unreachable', /FUNDING_RPC_URL/);
  });
});

describe('POST /api/admin-funding/transfers', () => {
  it('journals an xDAI transfer before it broadcasts it, then answers it submitted', async () => {
    const { chain, journal, service } = setup();
    const request = await xdaiRequest();
    let journalledAtSend: unknown = null;
    chain.onSend = () => void (journalledAtSend = journal.rows.get(REQUEST)?.state);
    const answer = await service.transfer(request);
    const hash = keccak256(request.rawTransaction as Hex);
    assert.deepEqual(answer, { requestId: REQUEST, state: 'submitted', txHash: hash });
    assert.equal(journalledAtSend, 'unknown', 'the row was not there, as unknown, when the broadcast went out');
    assert.deepEqual(chain.sent, [request.rawTransaction]);
    const row = journal.rows.get(REQUEST)!;
    assert.equal(row.sender, brand.address.toLowerCase());
    assert.equal(row.txHash, hash);
    assert.equal(row.toAddress, WALLET);
    assert.equal(row.state, 'submitted');
  });

  it('takes an xBZZ transfer: the token’s transfer(to, amount), no value', async () => {
    const { chain, service } = setup();
    const answer = await service.transfer(
      await xdaiRequest({ kind: 'xbzz', amount: '10000000000000000' }, await bzzSigned()),
    );
    assert.equal(answer.state, 'submitted');
    assert.equal(chain.sent.length, 1);
  });

  const refusals: Array<[string, () => Promise<FundingTransferRequest>, RegExp]> = [
    ['bytes that are no transaction', () => xdaiRequest({ rawTransaction: '0x02f8deadbeef' }), /decoded/],
    [
      'a legacy transaction',
      async () =>
        xdaiRequest(
          {},
          await brand.signTransaction({
            type: 'legacy',
            chainId: 100,
            nonce: 7,
            to: getAddress(WALLET),
            value: 10n ** 17n,
            gas: FUNDING_GAS_NATIVE,
            gasPrice: SUGGESTED_MAX_FEE,
          }),
        ),
      /EIP-1559/,
    ],
    ['another chain', async () => xdaiRequest({}, await signed({ chainId: 1 })), /chain 1/],
    [
      'xDAI to another address than the request names',
      async () => xdaiRequest({}, await signed({ to: getAddress(OTHER) })),
      /to/,
    ],
    ['xDAI of another amount', async () => xdaiRequest({}, await signed({ value: 10n ** 18n })), /amount/],
    ['xDAI with data', async () => xdaiRequest({}, await signed({ data: '0x1234' })), /data/],
    ['xDAI with too little gas to transfer', async () => xdaiRequest({}, await signed({ gas: 20_000n })), /gas/],
    [
      'a gas limit over three times the suggestion',
      async () => xdaiRequest({}, await signed({ gas: FUNDING_GAS_NATIVE * 3n + 1n })),
      /gas/,
    ],
    [
      'a fee cap over three times the suggestion',
      async () => xdaiRequest({}, await signed({ maxFeePerGas: SUGGESTED_MAX_FEE * 3n + 1n })),
      /fee/,
    ],
    [
      'an access list',
      async () => xdaiRequest({}, await signed({ accessList: [{ address: getAddress(OTHER), storageKeys: [] }] })),
      /access list/,
    ],
    [
      'xBZZ sent anywhere but the token',
      async () =>
        xdaiRequest({ kind: 'xbzz', amount: '10000000000000000' }, await bzzSigned({ to: getAddress(OTHER) })),
      /token/,
    ],
    [
      'xBZZ with a value',
      async () => xdaiRequest({ kind: 'xbzz', amount: '10000000000000000' }, await bzzSigned({ value: 1n })),
      /value/,
    ],
    [
      'xBZZ to another recipient',
      async () => xdaiRequest({ kind: 'xbzz', amount: '10000000000000000' }, await bzzSigned({}, OTHER)),
      /transfer/,
    ],
    [
      'xBZZ of another amount',
      async () => xdaiRequest({ kind: 'xbzz', amount: '10000000000000000' }, await bzzSigned({}, WALLET, 1n)),
      /transfer/,
    ],
    [
      'a tip above the fee cap',
      async () => xdaiRequest({}, await signedUnchecked(SUGGESTED_MAX_FEE + 1n, SUGGESTED_MAX_FEE)),
      /decoded|priority/,
    ],
    [
      'an EIP-2930 transaction',
      async () =>
        xdaiRequest(
          {},
          await brand.signTransaction({
            type: 'eip2930',
            chainId: 100,
            nonce: 7,
            to: getAddress(WALLET),
            value: 10n ** 17n,
            gas: FUNDING_GAS_NATIVE,
            gasPrice: SUGGESTED_MAX_FEE,
            accessList: [],
          }),
        ),
      /EIP-1559/,
    ],
    [
      'an EIP-7702 transaction',
      async () =>
        xdaiRequest(
          {},
          await brand.signTransaction({
            type: 'eip7702',
            chainId: 100,
            nonce: 7,
            to: getAddress(WALLET),
            value: 10n ** 17n,
            gas: FUNDING_GAS_NATIVE,
            maxFeePerGas: SUGGESTED_MAX_FEE,
            maxPriorityFeePerGas: 1_000_000_000n,
            authorizationList: [await brand.signAuthorization({ address: getAddress(OTHER), chainId: 100, nonce: 8 })],
          }),
        ),
      /EIP-1559/,
    ],
    ['a contract creation, with no to', async () => xdaiRequest({}, await signed({ to: undefined })), /to/],
    [
      'an unsigned transaction',
      async () =>
        xdaiRequest(
          {},
          serializeTransaction({
            type: 'eip1559',
            chainId: 100,
            nonce: 7,
            to: getAddress(WALLET),
            value: 10n ** 17n,
            gas: FUNDING_GAS_NATIVE,
            maxFeePerGas: SUGGESTED_MAX_FEE,
            maxPriorityFeePerGas: 1_000_000_000n,
          }),
        ),
      /signer/,
    ],
    [
      'an xBZZ amount of 2^256 or more',
      async () => xdaiRequest({ kind: 'xbzz', amount: (2n ** 256n).toString() }, await bzzSigned()),
      /amount/,
    ],
  ];
  for (const [what, request, pattern] of refusals) {
    it(`refuses ${what}, 422 bad_transaction, journalling and sending nothing`, async () => {
      const { chain, journal, service } = setup();
      await refusedWith(service.transfer(await request()), 'bad_transaction', pattern);
      assert.equal(journal.rows.size, 0);
      assert.deepEqual(chain.sent, []);
    });
  }

  it('refuses a node it does not know, one whose wallet is another address, and one it could not read', async () => {
    for (const over of [{ nodeId: 'nobody:bee-uploader' }, { nodeId: 'unread:bee-uploader' }]) {
      const { chain, journal, service } = setup();
      await refusedWith(service.transfer(await xdaiRequest(over)), 'unknown_node');
      assert.equal(journal.rows.size + chain.sent.length, 0);
    }
    const { chain, service } = setup();
    await refusedWith(
      service.transfer(await xdaiRequest({ to: OTHER }, await signed({ to: getAddress(OTHER) }))),
      'unknown_node',
      /wallet/,
    );
    assert.deepEqual(chain.sent, []);
  });

  it('answers chain_unreachable before journalling anything when the chain cannot price the transfer', async () => {
    const { chain, journal, service } = setup();
    chain.down = true;
    await refusedWith(service.transfer(await xdaiRequest()), 'chain_unreachable');
    assert.equal(journal.rows.size, 0);
  });

  it('answers the same request again with its state and never sends it twice', async () => {
    const { chain, service } = setup();
    const request = await xdaiRequest();
    const first = await service.transfer(request);
    const again = await service.transfer({ ...request });
    assert.deepEqual(again, first);
    assert.equal(chain.sent.length, 1);
  });

  it('refuses another body under a known request id, 409 conflict, and sends nothing', async () => {
    const { chain, service } = setup();
    await service.transfer(await xdaiRequest());
    await refusedWith(
      service.transfer(await xdaiRequest({ amount: '200000000000000000' }, await signed({ value: 2n * 10n ** 17n }))),
      'conflict',
    );
    assert.equal(chain.sent.length, 1);
  });

  it('keeps a transfer journalled before a crash, never sends it again, and settles it from its hash', async () => {
    const { chain, journal, service, advance } = setup();
    const request = await xdaiRequest();
    const hash = keccak256(request.rawTransaction as Hex);
    // As a manager that stopped between the journal and the broadcast leaves it.
    await journal.insert({
      requestId: REQUEST,
      nodeId: NODE,
      kind: 'xdai',
      toAddress: WALLET,
      amount: request.amount,
      sender: brand.address.toLowerCase(),
      txHash: hash,
      state: 'unknown',
      error: null,
      blockNumber: null,
      createdAt: new Date(START),
      updatedAt: new Date(START),
    });
    assert.deepEqual(await service.transfer(request), { requestId: REQUEST, state: 'unknown', txHash: hash });
    assert.deepEqual(chain.sent, []);
    advance(60_000);
    chain.receipts.set(hash, receipt(hash, 'success'));
    const status = await service.status(REQUEST);
    assert.equal(status.state, 'confirmed');
    assert.equal(status.blockNumber, 39_000_000);
  });

  it('leaves a transfer unknown when the broadcast’s answer is lost, and settles it later from its hash', async () => {
    const { chain, journal, service } = setup();
    chain.sendAnswer = async () => {
      throw new ChainReadError();
    };
    const request = await xdaiRequest();
    const answer = await service.transfer(request);
    assert.equal(answer.state, 'unknown');
    assert.equal(journal.rows.get(REQUEST)?.state, 'unknown');
    chain.pending.add(answer.txHash!);
    assert.equal((await service.status(REQUEST)).state, 'submitted', 'the chain knows the hash');
  });

  it('marks a transfer the chain refused failed, with a sentence, and one it already holds submitted', async () => {
    const refused = setup();
    refused.chain.sendAnswer = async () => ({ kind: 'refused', reason: 'nonce' });
    const failed = await refused.service.transfer(await xdaiRequest());
    assert.equal(failed.state, 'failed');
    assert.match(refused.journal.rows.get(REQUEST)?.error ?? '', /nonce/);
    const known = setup();
    known.chain.sendAnswer = async () => ({ kind: 'refused', reason: 'known' });
    assert.equal((await known.service.transfer(await xdaiRequest())).state, 'submitted');
  });
});

function receipt(hash: string, status: 'success' | 'reverted'): ChainReceipt {
  return {
    transactionHash: hash,
    blockHash: `0x${'cd'.repeat(32)}`,
    blockNumber: '39000000',
    from: brand.address.toLowerCase(),
    to: WALLET,
    status,
  };
}

describe('GET /api/admin-funding/transfers/:requestId', () => {
  it('answers confirmed with the block, or failed when it reverted, from the receipt', async () => {
    const ok = setup();
    const sent = await ok.service.transfer(await xdaiRequest());
    ok.chain.receipts.set(sent.txHash!, receipt(sent.txHash!, 'success'));
    assert.deepEqual(await ok.service.status(REQUEST), {
      requestId: REQUEST,
      state: 'confirmed',
      txHash: sent.txHash,
      blockNumber: 39_000_000,
      error: null,
    });
    assert.equal(ok.journal.rows.get(REQUEST)?.state, 'confirmed', 'the journal keeps what the receipt said');

    const reverted = setup();
    const lost = await reverted.service.transfer(await xdaiRequest());
    reverted.chain.receipts.set(lost.txHash!, receipt(lost.txHash!, 'reverted'));
    const status = await reverted.service.status(REQUEST);
    assert.equal(status.state, 'failed');
    assert.match(status.error ?? '', /reverted/);
  });

  it('keeps a transfer submitted while the chain still holds it, and makes it unknown once it is long gone', async () => {
    const { chain, service, advance } = setup();
    const sent = await service.transfer(await xdaiRequest());
    chain.pending.add(sent.txHash!);
    advance(FUNDING_UNKNOWN_AFTER_MS + 1);
    assert.equal((await service.status(REQUEST)).state, 'submitted');
    chain.pending.clear();
    advance(5_000);
    const gone = await service.status(REQUEST);
    assert.equal(gone.state, 'unknown');
    assert.match(gone.error ?? '', /no longer/);
  });

  it('keeps a transfer submitted before that, with no receipt and the chain not holding it', async () => {
    const { service, advance } = setup();
    await service.transfer(await xdaiRequest());
    advance(FUNDING_UNKNOWN_AFTER_MS - 1);
    assert.equal((await service.status(REQUEST)).state, 'submitted');
  });

  it('answers the journalled state when the chain does not answer, and 404 for a request id it never took', async () => {
    const { chain, service } = setup();
    await service.transfer(await xdaiRequest());
    chain.down = true;
    assert.equal((await service.status(REQUEST)).state, 'submitted');
    await refusedWith(service.status('0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b'), 'unknown_request', /request id/);
  });
});

/** A journal another call wins the insert in: insert answers false, having written `racer` (or nothing). */
class RacedJournal extends InMemoryFundingTransferJournal {
  constructor(private readonly racer: FundingTransferRow | null) {
    super();
  }
  override async insert(): Promise<boolean> {
    if (this.racer) this.rows.set(this.racer.requestId, { ...this.racer });
    return false;
  }
}

function journalled(over: Partial<FundingTransferRow> & Pick<FundingTransferRow, 'txHash'>): FundingTransferRow {
  return {
    requestId: REQUEST,
    nodeId: NODE,
    kind: 'xdai',
    toAddress: WALLET,
    amount: '100000000000000000',
    sender: brand.address.toLowerCase(),
    state: 'submitted',
    error: null,
    blockNumber: null,
    createdAt: new Date(START),
    updatedAt: new Date(START),
    ...over,
  };
}

describe('what the review pinned', () => {
  it('answers the winner of an insert race for the same body, and a conflict for another, sending nothing', async () => {
    const request = await xdaiRequest();
    const hash = keccak256(request.rawTransaction as Hex);
    const same = setup({ journal: new RacedJournal(journalled({ txHash: hash })) });
    assert.deepEqual(await same.service.transfer(request), { requestId: REQUEST, state: 'submitted', txHash: hash });
    assert.deepEqual(same.chain.sent, []);
    const other = setup({ journal: new RacedJournal(journalled({ txHash: hash, amount: '1' })) });
    await refusedWith(other.service.transfer(request), 'conflict');
    assert.deepEqual(other.chain.sent, []);
  });

  it('never broadcasts without a journal row: an insert that writes nothing and leaves nothing throws', async () => {
    const { chain, service } = setup({ journal: new RacedJournal(null) });
    await assert.rejects(service.transfer(await xdaiRequest()), /journal/);
    assert.deepEqual(chain.sent, []);
  });

  it('answers chain_unreachable for a chain answer it cannot read, in the account and before a transfer', async () => {
    const account = setup();
    account.chain.garbled = true;
    await refusedWith(account.service.account(brand.address), 'chain_unreachable');
    const transfer = setup();
    transfer.chain.garbled = true;
    await refusedWith(transfer.service.transfer(await xdaiRequest()), 'chain_unreachable');
    assert.equal(transfer.journal.rows.size, 0);
  });

  it('answers the journalled state when the receipt it reads is not one', async () => {
    const { chain, service } = setup();
    await service.transfer(await xdaiRequest());
    chain.garbled = true;
    assert.equal((await service.status(REQUEST)).state, 'submitted');
  });

  it('settles a transfer refused at the broadcast by its receipt, and never drifts it to unknown', async () => {
    const { chain, journal, service, advance } = setup();
    chain.sendAnswer = async () => ({ kind: 'refused', reason: 'other' });
    const refused = await service.transfer(await xdaiRequest());
    assert.equal(refused.state, 'failed');
    const recorded = { ...journal.rows.get(REQUEST)! };
    advance(FUNDING_UNKNOWN_AFTER_MS + 10_000);
    const still = await service.status(REQUEST);
    assert.equal(still.state, 'failed', 'no receipt and not in the pool leaves it as the refusal recorded it');
    assert.equal(still.blockNumber, null);
    assert.equal(still.error, recorded.error);
    assert.deepEqual(journal.rows.get(REQUEST), recorded, 'the journal row is not touched');
    chain.receipts.set(refused.txHash!, receipt(refused.txHash!, 'success'));
    advance(5_000);
    const mined = await service.status(REQUEST);
    assert.equal(mined.state, 'confirmed', 'the refusal was a node’s word; the chain mined it anyway');
    assert.equal(mined.blockNumber, 39_000_000);
  });

  it('answers submitted for a transfer refused at the broadcast that the chain holds in its pool', async () => {
    const { chain, journal, service } = setup();
    chain.sendAnswer = async () => ({ kind: 'refused', reason: 'other' });
    const refused = await service.transfer(await xdaiRequest());
    assert.equal(refused.state, 'failed');
    // The node answered with an error yet kept the transaction: a failed item with no block would open the admin's
    // one-send gate, and its next send would take the next nonce while this one is still mined.
    chain.pending.add(refused.txHash!);
    assert.deepEqual(await service.status(REQUEST), {
      requestId: REQUEST,
      state: 'submitted',
      txHash: refused.txHash,
      blockNumber: null,
      error: null,
    });
    const row = journal.rows.get(REQUEST);
    assert.equal(row?.state, 'submitted', 'the journal keeps what the pool said');
    assert.equal(row?.error, null);
    assert.equal(row?.blockNumber, null);
  });

  it('keeps the hash it worked out when the chain answers another, and warns with the two hashes', async (t) => {
    const warnings: string[] = [];
    t.mock.method(Logger.prototype, 'warn', (...args: unknown[]) => void warnings.push(args.map(String).join(' ')));
    const { chain, journal, service } = setup();
    const other = `0x${'ef'.repeat(32)}`;
    chain.sendAnswer = async () => ({ kind: 'sent', hash: other });
    const request = await xdaiRequest();
    const hash = keccak256(request.rawTransaction as Hex);
    assert.equal((await service.transfer(request)).txHash, hash);
    assert.equal(journal.rows.get(REQUEST)?.txHash, hash);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes(hash) && warnings[0]!.includes(other), warnings[0]);
  });

  it('reads the chain for a request id at most once every five seconds, answering the journal in between', async () => {
    const { chain, service, advance } = setup();
    await service.transfer(await xdaiRequest());
    await service.status(REQUEST);
    assert.equal(chain.receiptReads, 1);
    advance(4_999);
    await service.status(REQUEST);
    await service.status(REQUEST);
    assert.equal(chain.receiptReads, 1);
    advance(1);
    await service.status(REQUEST);
    assert.equal(chain.receiptReads, 2);
  });
});
