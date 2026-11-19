import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ADMIN_FUNDING_PATH,
  FUNDING_BATCH_PURCHASE_PURPOSES,
  FUNDING_BATCH_PURCHASES_PATH,
  FUNDING_CHEQUEBOOK_DIRECTIONS,
  FUNDING_CHEQUEBOOK_OPERATIONS_PATH,
  FUNDING_ERROR_CODES,
  FUNDING_ERROR_STATUS,
  FUNDING_INVENTORY_PATH,
  FUNDING_NODE_ROLES,
  FUNDING_PURCHASE_APPLY_STATES,
  FUNDING_PURCHASE_STEPS,
  FUNDING_STAMP_OPERATION_KINDS,
  FUNDING_STAMP_OPERATIONS_PATH,
  FUNDING_STAMP_PURCHASES_PATH,
  FUNDING_TRANSFER_KINDS,
  FUNDING_TRANSFER_STATES,
  FUNDING_TRANSFERS_PATH,
  MANAGER_API_TOKEN_FORMER_KEY_IN_ADMIN,
  MANAGER_API_TOKEN_FORMER_KEY_IN_MANAGER,
  MANAGER_API_TOKEN_KEY,
  fundingAccountAnswerSchema,
  fundingAccountPath,
  fundingArchiveBatchSchema,
  fundingBatchPurchaseAnswerSchema,
  fundingBatchPurchaseCheckPath,
  fundingBatchPurchasePath,
  fundingBatchPurchaseReleasePath,
  fundingBatchPurchaseRequestSchema,
  fundingBatchPurchaseRestartPath,
  fundingBatchPurchaseRestartRequestSchema,
  fundingBatchPurchaseStatusSchema,
  fundingBatchSchema,
  fundingChainSchema,
  fundingChequebookOperationAnswerSchema,
  fundingChequebookOperationPath,
  fundingChequebookOperationRequestSchema,
  fundingChequebookOperationStatusSchema,
  fundingChequebookSchema,
  fundingErrorAnswerSchema,
  fundingInventorySchema,
  fundingNodeSchema,
  fundingPostageSchema,
  fundingPurchaseApplySettled,
  fundingPurchaseRestartable,
  fundingStampOperationAnswerSchema,
  fundingStampOperationPath,
  fundingStampOperationRequestSchema,
  fundingStampOperationStatusSchema,
  fundingStampPurchaseAnswerSchema,
  fundingStampPurchasePath,
  fundingStampPurchaseRequestSchema,
  fundingStampPurchaseStatusSchema,
  fundingTransferAnswerSchema,
  fundingTransferPath,
  fundingTransferRequestSchema,
  fundingTransferStatusSchema,
  managerApiTokenFrom,
} from './funding.js';

const STAGE_ID = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const REQUEST_ID = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const WALLET = '0x1111111111111111111111111111111111111111';
const BRAND = '0x2222222222222222222222222222222222222222';
const BZZ_TOKEN = '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';
const TX_HASH = `0x${'ab'.repeat(32)}`;
const BATCH_ID = `0x${'c3'.repeat(32)}`;

const node = () => ({
  nodeId: `${STAGE_ID}:bee-uploader`,
  label: 'main stage 360p',
  role: 'uploader',
  walletAddress: WALLET,
  xdaiWei: '250000000000000000',
  xbzzPlur: '10000000000000000',
  readError: null,
});

const inventory = () => ({
  observedAt: '2026-10-05T10:00:00.000Z',
  chain: { chainId: 100, bzzToken: BZZ_TOKEN },
  stages: [{ stageId: STAGE_ID, name: 'main stage', nodes: [node()] }],
  catalogue: { ...node(), nodeId: 'catalogue:bee-uploader', label: 'catalogue', role: 'uploader' },
});

const account = () => ({
  address: BRAND,
  chainId: 100,
  xdaiWei: '1000000000000000000',
  xbzzPlur: '500000000000000000',
  nonce: 7,
  maxFeePerGasWei: '2000000000',
  maxPriorityFeePerGasWei: '1000000000',
  gasNative: '21000',
  gasBzzTransfer: '65000',
});

const transferRequest = () => ({
  requestId: REQUEST_ID,
  nodeId: `${STAGE_ID}:bee-uploader`,
  kind: 'xdai',
  to: WALLET,
  amount: '100000000000000000',
  rawTransaction: `0x02f8${'0a'.repeat(100)}`,
});

const batch = () => ({
  batchId: BATCH_ID,
  depth: 22,
  immutable: true,
  usable: true,
  ttlSeconds: 1_296_000,
  fillRatio: 0.25,
  readError: null,
});

const postage = () => ({ pricePerChunkPerBlockPlur: '24000', blockSeconds: 5, minimumValidityBlocks: 17280 });

const topUpRequest = () => ({
  requestId: REQUEST_ID,
  kind: 'topup',
  nodeId: `${STAGE_ID}:bee-uploader`,
  batchId: BATCH_ID,
  expectedDepth: 22,
  amountPerChunkPlur: '414720000',
});

const diluteRequest = () => ({
  requestId: REQUEST_ID,
  kind: 'dilute',
  nodeId: `${STAGE_ID}:bee-uploader`,
  batchId: BATCH_ID,
  expectedDepth: 22,
  newDepth: 23,
});

const CHEQUEBOOK = '0x3333333333333333333333333333333333333333';

const chequebook = () => ({
  address: CHEQUEBOOK,
  availablePlur: '9500000000000000',
  totalPlur: '10000000000000000',
  readError: null,
});

const depositRequest = () => ({
  requestId: REQUEST_ID,
  nodeId: `${STAGE_ID}:bee-uploader`,
  direction: 'deposit',
  amountPlur: '500000000000000',
});

describe('the paths under /api/admin-funding', () => {
  it('names each route under the one prefix', () => {
    assert.equal(ADMIN_FUNDING_PATH, '/api/admin-funding');
    assert.equal(FUNDING_INVENTORY_PATH, '/api/admin-funding/inventory');
    assert.equal(FUNDING_TRANSFERS_PATH, '/api/admin-funding/transfers');
  });

  it('builds an account path from an address in lower case, and refuses anything else', () => {
    assert.equal(fundingAccountPath(BRAND.toUpperCase().replace('0X', '0x')), `/api/admin-funding/accounts/${BRAND}`);
    for (const bad of ['', '0x12', 'not-an-address', `${BRAND}/../inventory`]) {
      assert.throws(() => fundingAccountPath(bad), /address/);
    }
  });

  it('builds a transfer path from a UUID in lower case, and refuses anything else', () => {
    assert.equal(fundingTransferPath(REQUEST_ID.toUpperCase()), `/api/admin-funding/transfers/${REQUEST_ID}`);
    for (const bad of ['', 'self', '../inventory']) {
      assert.throws(() => fundingTransferPath(bad), /UUID/);
    }
  });

  it('builds a stamp operation path from a UUID in lower case, and refuses anything else', () => {
    assert.equal(FUNDING_STAMP_OPERATIONS_PATH, '/api/admin-funding/stamp-operations');
    assert.equal(
      fundingStampOperationPath(REQUEST_ID.toUpperCase()),
      `/api/admin-funding/stamp-operations/${REQUEST_ID}`,
    );
    for (const bad of ['', 'self', '../transfers', `${REQUEST_ID}/x`]) {
      assert.throws(() => fundingStampOperationPath(bad), /UUID/);
    }
  });

  it('builds a stamp purchase path from a UUID in lower case, and refuses anything else', () => {
    assert.equal(FUNDING_STAMP_PURCHASES_PATH, '/api/admin-funding/stamp-purchases');
    assert.equal(
      fundingStampPurchasePath(REQUEST_ID.toUpperCase()),
      `/api/admin-funding/stamp-purchases/${REQUEST_ID}`,
    );
    for (const bad of ['', 'self', '../stamp-operations', `${REQUEST_ID}/x`]) {
      assert.throws(() => fundingStampPurchasePath(bad), /UUID/);
    }
  });

  it('builds a chequebook operation path from a UUID in lower case, and refuses anything else', () => {
    assert.equal(FUNDING_CHEQUEBOOK_OPERATIONS_PATH, '/api/admin-funding/chequebook-operations');
    assert.equal(
      fundingChequebookOperationPath(REQUEST_ID.toUpperCase()),
      `/api/admin-funding/chequebook-operations/${REQUEST_ID}`,
    );
    for (const bad of ['', 'self', '../stamp-operations', `${REQUEST_ID}/x`]) {
      assert.throws(() => fundingChequebookOperationPath(bad), /UUID/);
    }
  });
});

describe('the closed lists', () => {
  it('names the roles, kinds, states and error codes the plan names, and a status for each code', () => {
    assert.deepEqual(FUNDING_NODE_ROLES, ['uploader', 'gateway', 'rung']);
    assert.deepEqual(FUNDING_TRANSFER_KINDS, ['xdai', 'xbzz']);
    assert.deepEqual(FUNDING_TRANSFER_STATES, ['submitted', 'confirmed', 'failed', 'unknown']);
    assert.deepEqual(FUNDING_STAMP_OPERATION_KINDS, ['topup', 'dilute']);
    assert.deepEqual(FUNDING_CHEQUEBOOK_DIRECTIONS, ['deposit', 'withdraw']);
    assert.deepEqual(FUNDING_ERROR_CODES, [
      'funding_off',
      'unauthorized',
      'unknown_node',
      'bad_transaction',
      'chain_unreachable',
      'conflict',
      'unknown_request',
      'stamp_refused',
      'node_unreachable',
      'chequebook_refused',
    ]);
    assert.deepEqual(Object.keys(FUNDING_ERROR_STATUS).sort(), [...FUNDING_ERROR_CODES].sort());
    assert.equal(FUNDING_ERROR_STATUS.funding_off, 404, 'an API that is off looks like no API');
    assert.equal(FUNDING_ERROR_STATUS.unauthorized, 401);
    assert.equal(FUNDING_ERROR_STATUS.unknown_request, 404, 'a transfer the manager never received');
    assert.equal(FUNDING_ERROR_STATUS.stamp_refused, 422, 'a stamp operation a check refused');
    assert.equal(FUNDING_ERROR_STATUS.node_unreachable, 502, 'a node whose Bee API did not answer');
    assert.equal(FUNDING_ERROR_STATUS.chequebook_refused, 422, 'a chequebook operation a check refused');
  });
});

describe('GET /api/admin-funding/inventory', () => {
  it('takes an inventory and keeps addresses in lower case', () => {
    const parsed = fundingInventorySchema.parse({
      ...inventory(),
      chain: { chainId: 100, bzzToken: BZZ_TOKEN.toUpperCase().replace('0X', '0x') },
    });
    assert.equal(parsed.chain.bzzToken, BZZ_TOKEN);
    assert.equal(parsed.stages[0]!.nodes[0]!.walletAddress, WALLET);
    assert.equal(parsed.catalogue?.label, 'catalogue');
  });

  it('drops a field it does not name, so nothing a newer manager adds is kept, a node address included', () => {
    const parsed = fundingInventorySchema.parse({
      ...inventory(),
      rpcEndpoint: 'https://rpc.example.org',
      stages: [{ ...inventory().stages[0], beeApiUrl: 'http://192.0.2.10:1633', nodes: [{ ...node(), key: 'x' }] }],
    });
    assert.equal('rpcEndpoint' in parsed, false);
    assert.equal('beeApiUrl' in parsed.stages[0]!, false);
    assert.equal('key' in parsed.stages[0]!.nodes[0]!, false);
  });

  it('takes a node whose wallet could not be read, with nulls and the reason', () => {
    const parsed = fundingNodeSchema.parse({
      ...node(),
      walletAddress: null,
      xdaiWei: null,
      xbzzPlur: null,
      readError: 'the node did not answer',
    });
    assert.equal(parsed.walletAddress, null);
    assert.equal(parsed.readError, 'the node did not answer');
  });

  it('takes no catalogue node', () => {
    assert.equal(fundingInventorySchema.parse({ ...inventory(), catalogue: null }).catalogue, null);
  });

  it('refuses an amount that is not a whole number of base units, and a role it does not know', () => {
    for (const xdaiWei of ['0.25', '-1', '1e18', '', ' 1', '01', 100]) {
      assert.equal(fundingNodeSchema.safeParse({ ...node(), xdaiWei }).success, false, JSON.stringify(xdaiWei));
    }
    assert.equal(fundingNodeSchema.safeParse({ ...node(), role: 'catalogue' }).success, false);
  });

  it('refuses a node id that would not survive a path or a log line', () => {
    for (const nodeId of ['', 'a b', 'a/b', 'x'.repeat(201), 'line\nbreak']) {
      assert.equal(fundingNodeSchema.safeParse({ ...node(), nodeId }).success, false, JSON.stringify(nodeId));
    }
  });
});

describe("a node's batch and the price of postage, in the inventory", () => {
  it("takes a node's batch and keeps its id in lower case", () => {
    const parsed = fundingNodeSchema.parse({
      ...node(),
      batch: { ...batch(), batchId: BATCH_ID.toUpperCase().replace('0X', '0x') },
    });
    assert.deepEqual(parsed.batch, batch());
  });

  it('takes a node with no batch, such as a gateway, and the node of a manager that answers no batch at all', () => {
    assert.equal(fundingNodeSchema.parse({ ...node(), role: 'gateway', batch: null }).batch, null);
    const older = fundingNodeSchema.parse(node());
    assert.equal(older.batch, undefined);
    assert.equal('batch' in older, false);
  });

  it('takes a batch the node could not be read about, with null readings and the reason', () => {
    const unread = {
      batchId: BATCH_ID,
      depth: null,
      immutable: null,
      usable: null,
      ttlSeconds: null,
      fillRatio: null,
      readError: 'The node did not answer in time.',
    };
    assert.deepEqual(fundingBatchSchema.parse(unread), unread);
  });

  it('takes an expired batch, whose time left is 0, and a full one, whose fill is 1', () => {
    assert.equal(fundingBatchSchema.parse({ ...batch(), ttlSeconds: 0, usable: false }).ttlSeconds, 0);
    assert.equal(fundingBatchSchema.parse({ ...batch(), fillRatio: 1 }).fillRatio, 1);
    assert.equal(fundingBatchSchema.parse({ ...batch(), fillRatio: 0 }).fillRatio, 0);
  });

  it('refuses a batch id that is not 0x and 64 hex digits, and readings that are not what a batch has', () => {
    const refused = (over: Record<string, unknown>) =>
      fundingBatchSchema.safeParse({ ...batch(), ...over }).success === false;
    for (const batchId of ['c3'.repeat(32), `0x${'c3'.repeat(31)}`, `0x${'zz'.repeat(32)}`, '']) {
      assert.ok(refused({ batchId }), JSON.stringify(batchId));
    }
    for (const depth of [-1, 22.5, 256, '22']) assert.ok(refused({ depth }), JSON.stringify(depth));
    for (const ttlSeconds of [-1, 1.5, 2 ** 53, '60']) assert.ok(refused({ ttlSeconds }), JSON.stringify(ttlSeconds));
    for (const fillRatio of [-0.1, 1.01, '0.5']) assert.ok(refused({ fillRatio }), JSON.stringify(fillRatio));
    assert.ok(refused({ usable: 'yes' }));
    assert.ok(refused({ immutable: 1 }));
  });

  it('takes the price of postage, null when no node answered, and none from a manager that reads none', () => {
    const chain = { chainId: 100, bzzToken: BZZ_TOKEN };
    assert.deepEqual(fundingChainSchema.parse({ ...chain, postage: postage() }).postage, postage());
    assert.equal(fundingChainSchema.parse({ ...chain, postage: null }).postage, null);
    assert.equal('postage' in fundingChainSchema.parse(chain), false);
    assert.deepEqual(
      fundingInventorySchema.parse({ ...inventory(), chain: { ...chain, postage: postage() } }).chain.postage,
      postage(),
    );
  });

  it('refuses a price, a block time or a floor that is not a whole number above 0', () => {
    const refused = (over: Record<string, unknown>) =>
      fundingPostageSchema.safeParse({ ...postage(), ...over }).success === false;
    for (const pricePerChunkPerBlockPlur of ['0', '1.5', '-1', 24000, '']) {
      assert.ok(refused({ pricePerChunkPerBlockPlur }), JSON.stringify(pricePerChunkPerBlockPlur));
    }
    for (const blockSeconds of [0, -5, 5.5, '5']) assert.ok(refused({ blockSeconds }), JSON.stringify(blockSeconds));
    for (const minimumValidityBlocks of [0, 17280.5, '17280']) {
      assert.ok(refused({ minimumValidityBlocks }), JSON.stringify(minimumValidityBlocks));
    }
  });
});

describe('GET /api/admin-funding/accounts/:address', () => {
  it('takes the account with the pending nonce and the fees and gas limits as decimal strings', () => {
    const parsed = fundingAccountAnswerSchema.parse(account());
    assert.equal(parsed.nonce, 7);
    assert.equal(parsed.gasBzzTransfer, '65000');
  });

  it('refuses a fee written as a number, and a nonce that is not a whole number', () => {
    assert.equal(fundingAccountAnswerSchema.safeParse({ ...account(), maxFeePerGasWei: 2e9 }).success, false);
    assert.equal(fundingAccountAnswerSchema.safeParse({ ...account(), nonce: 1.5 }).success, false);
    assert.equal(fundingAccountAnswerSchema.safeParse({ ...account(), nonce: -1 }).success, false);
  });
});

describe('POST /api/admin-funding/transfers', () => {
  it('takes a request and keeps the ids and addresses in lower case', () => {
    const parsed = fundingTransferRequestSchema.parse({
      ...transferRequest(),
      requestId: REQUEST_ID.toUpperCase(),
      to: WALLET.toUpperCase().replace('0X', '0x'),
    });
    assert.equal(parsed.requestId, REQUEST_ID);
    assert.equal(parsed.to, WALLET);
  });

  it('refuses an amount of nothing, a kind it does not know, and a signed transaction that is not hex', () => {
    const refused = (over: Record<string, unknown>) =>
      fundingTransferRequestSchema.safeParse({ ...transferRequest(), ...over }).success === false;
    assert.ok(refused({ amount: '0' }), 'an amount of nothing sends nothing');
    assert.ok(refused({ amount: '1.5' }));
    assert.ok(refused({ kind: 'eth' }));
    assert.ok(refused({ requestId: 'not-a-uuid' }));
    assert.ok(refused({ rawTransaction: '0x02f8zz' }));
    assert.ok(refused({ rawTransaction: '02f8' }));
    assert.ok(refused({ rawTransaction: `0x${'0'.repeat(9)}` }), 'an odd number of digits is no byte string');
  });

  it('answers the request id, a state and the transaction hash once there is one', () => {
    assert.deepEqual(
      fundingTransferAnswerSchema.parse({ requestId: REQUEST_ID, state: 'submitted', txHash: TX_HASH }),
      {
        requestId: REQUEST_ID,
        state: 'submitted',
        txHash: TX_HASH,
      },
    );
    assert.equal(
      fundingTransferAnswerSchema.parse({ requestId: REQUEST_ID, state: 'unknown', txHash: null }).txHash,
      null,
    );
  });
});

describe('the bounds the schemas hold', () => {
  it('takes base units up to 78 digits, a 256-bit number, and refuses 79', () => {
    const max = (2n ** 256n - 1n).toString();
    assert.equal(max.length, 78);
    assert.equal(fundingNodeSchema.parse({ ...node(), xdaiWei: max }).xdaiWei, max);
    assert.equal(fundingNodeSchema.safeParse({ ...node(), xdaiWei: `1${'0'.repeat(78)}` }).success, false);
  });

  it('takes a signed transaction of 65536 bytes and refuses 65537', () => {
    const bytes = (count: number) => `0x${'ab'.repeat(count)}`;
    assert.equal(
      fundingTransferRequestSchema.safeParse({ ...transferRequest(), rawTransaction: bytes(65536) }).success,
      true,
    );
    assert.equal(
      fundingTransferRequestSchema.safeParse({ ...transferRequest(), rawTransaction: bytes(65537) }).success,
      false,
    );
  });
});

describe('GET /api/admin-funding/transfers/:requestId', () => {
  it('answers the state with the block and the error, each null until there is one', () => {
    const confirmed = fundingTransferStatusSchema.parse({
      requestId: REQUEST_ID,
      state: 'confirmed',
      txHash: TX_HASH,
      blockNumber: 39_000_000,
      error: null,
    });
    assert.equal(confirmed.blockNumber, 39_000_000);
    const failed = fundingTransferStatusSchema.parse({
      requestId: REQUEST_ID,
      state: 'failed',
      txHash: null,
      blockNumber: null,
      error: 'nonce too low',
    });
    assert.equal(failed.error, 'nonce too low');
    assert.equal(
      fundingTransferStatusSchema.safeParse({ ...confirmed, state: 'pending' }).success,
      false,
      'only the four states',
    );
  });
});

describe('POST /api/admin-funding/stamp-operations', () => {
  it('takes a top-up and keeps the ids in lower case', () => {
    const parsed = fundingStampOperationRequestSchema.parse({
      ...topUpRequest(),
      requestId: REQUEST_ID.toUpperCase(),
      batchId: BATCH_ID.toUpperCase().replace('0X', '0x'),
    });
    assert.deepEqual(parsed, topUpRequest());
  });

  it('takes a dilution of one step or of two', () => {
    assert.equal(fundingStampOperationRequestSchema.parse(diluteRequest()).kind, 'dilute');
    const twoSteps = fundingStampOperationRequestSchema.parse({ ...diluteRequest(), newDepth: 24 });
    assert.equal(twoSteps.kind === 'dilute' && twoSteps.newDepth, 24);
  });

  it('refuses a dilution of no step, of three, or to a shallower depth', () => {
    for (const newDepth of [22, 25, 21]) {
      const result = fundingStampOperationRequestSchema.safeParse({ ...diluteRequest(), newDepth });
      assert.equal(result.success, false, `to depth ${newDepth} from 22`);
      assert.deepEqual(result.error?.issues[0]?.path, ['newDepth']);
    }
  });

  it('refuses a top-up of nothing, a kind it does not know, and an operation missing its own field', () => {
    const refused = (body: Record<string, unknown>) =>
      fundingStampOperationRequestSchema.safeParse(body).success === false;
    assert.ok(refused({ ...topUpRequest(), amountPerChunkPlur: '0' }), 'a top-up of nothing buys nothing');
    assert.ok(refused({ ...topUpRequest(), amountPerChunkPlur: '1.5' }));
    assert.ok(refused({ ...topUpRequest(), kind: 'buy' }));
    const { amountPerChunkPlur: _amount, ...noAmount } = topUpRequest();
    assert.ok(refused(noAmount), 'a top-up with no amount');
    const { newDepth: _newDepth, ...noDepth } = diluteRequest();
    assert.ok(refused(noDepth), 'a dilution with no depth');
    assert.ok(refused({ ...topUpRequest(), kind: 'dilute' }), 'a top-up body named a dilution');
    assert.ok(refused({ ...topUpRequest(), requestId: 'not-a-uuid' }));
    assert.ok(refused({ ...topUpRequest(), batchId: 'c3'.repeat(32) }), 'a batch id without 0x');
    assert.ok(refused({ ...topUpRequest(), expectedDepth: 22.5 }));
    assert.ok(refused({ ...topUpRequest(), nodeId: 'a/b' }));
  });

  it("drops a field the operation's kind does not name", () => {
    const parsed = fundingStampOperationRequestSchema.parse({ ...topUpRequest(), newDepth: 30, days: 30 });
    assert.equal('newDepth' in parsed, false);
    assert.equal('days' in parsed, false);
  });

  it('answers the request id, the kind, a state and the transaction hash once there is one', () => {
    assert.deepEqual(
      fundingStampOperationAnswerSchema.parse({
        requestId: REQUEST_ID,
        kind: 'topup',
        state: 'confirmed',
        txHash: TX_HASH,
      }),
      { requestId: REQUEST_ID, kind: 'topup', state: 'confirmed', txHash: TX_HASH },
    );
    assert.equal(
      fundingStampOperationAnswerSchema.parse({ requestId: REQUEST_ID, kind: 'dilute', state: 'unknown', txHash: null })
        .txHash,
      null,
    );
    assert.equal(
      fundingStampOperationAnswerSchema.safeParse({
        requestId: REQUEST_ID,
        kind: 'buy',
        state: 'confirmed',
        txHash: null,
      }).success,
      false,
    );
  });
});

describe('GET /api/admin-funding/stamp-operations/:requestId', () => {
  it('answers the state with the hash and the error, each null until there is one, in the four states only', () => {
    const failed = fundingStampOperationStatusSchema.parse({
      requestId: REQUEST_ID,
      kind: 'dilute',
      state: 'failed',
      txHash: null,
      error: 'The node refused it: the batch is not usable.',
    });
    assert.equal(failed.error, 'The node refused it: the batch is not usable.');
    const confirmed = fundingStampOperationStatusSchema.parse({
      ...failed,
      state: 'confirmed',
      txHash: TX_HASH,
      error: null,
    });
    assert.equal(confirmed.txHash, TX_HASH);
    assert.equal(fundingStampOperationStatusSchema.safeParse({ ...confirmed, state: 'pending' }).success, false);
  });
});

describe("a node's chequebook, in the inventory", () => {
  it("takes a node's chequebook and keeps its address in lower case", () => {
    const parsed = fundingNodeSchema.parse({
      ...node(),
      chequebook: { ...chequebook(), address: CHEQUEBOOK.toUpperCase().replace('0X', '0x') },
    });
    assert.deepEqual(parsed.chequebook, chequebook());
  });

  it('takes a node that has no chequebook, and the node of a manager that answers no chequebook at all', () => {
    assert.equal(fundingNodeSchema.parse({ ...node(), role: 'gateway', chequebook: null }).chequebook, null);
    const older = fundingNodeSchema.parse(node());
    assert.equal(older.chequebook, undefined);
    assert.equal('chequebook' in older, false);
  });

  it('takes a chequebook the node could not be read about, with null readings and the reason', () => {
    const unread = {
      address: null,
      availablePlur: null,
      totalPlur: null,
      readError: 'The node did not answer in time.',
    };
    assert.deepEqual(fundingChequebookSchema.parse(unread), unread);
  });

  it('takes an empty chequebook, and refuses readings that are not an address or base units', () => {
    const empty = { ...chequebook(), availablePlur: '0', totalPlur: '0' };
    assert.deepEqual(fundingChequebookSchema.parse(empty), empty);
    const refused = (over: Record<string, unknown>) =>
      fundingChequebookSchema.safeParse({ ...chequebook(), ...over }).success === false;
    for (const address of ['0x12', CHEQUEBOOK.slice(2), '']) assert.ok(refused({ address }), JSON.stringify(address));
    for (const availablePlur of ['0.5', '-1', '1e16', '01', 1]) {
      assert.ok(refused({ availablePlur }), JSON.stringify(availablePlur));
    }
    for (const totalPlur of ['0.5', '-1', '', 10]) assert.ok(refused({ totalPlur }), JSON.stringify(totalPlur));
  });

  it('drops a field it does not name, a chequebook owner or a Bee API address among them', () => {
    const parsed = fundingChequebookSchema.parse({ ...chequebook(), owner: WALLET, apiUrl: 'http://bee.invalid:1633' });
    assert.equal('owner' in parsed, false);
    assert.equal('apiUrl' in parsed, false);
  });
});

describe('POST /api/admin-funding/chequebook-operations', () => {
  it('takes a deposit and a withdrawal, and keeps the request id in lower case', () => {
    assert.deepEqual(
      fundingChequebookOperationRequestSchema.parse({ ...depositRequest(), requestId: REQUEST_ID.toUpperCase() }),
      depositRequest(),
    );
    assert.equal(
      fundingChequebookOperationRequestSchema.parse({ ...depositRequest(), direction: 'withdraw' }).direction,
      'withdraw',
    );
  });

  it('takes an amount of up to 30 digits, as the manager journals one, and refuses 31', () => {
    const amountPlur = '9'.repeat(30);
    assert.equal(
      fundingChequebookOperationRequestSchema.parse({ ...depositRequest(), amountPlur }).amountPlur,
      amountPlur,
    );
    assert.equal(
      fundingChequebookOperationRequestSchema.safeParse({ ...depositRequest(), amountPlur: '1'.repeat(31) }).success,
      false,
    );
  });

  it('refuses a move of nothing, a direction it does not know, and a request missing a field', () => {
    const refused = (body: Record<string, unknown>) =>
      fundingChequebookOperationRequestSchema.safeParse(body).success === false;
    assert.ok(refused({ ...depositRequest(), amountPlur: '0' }), 'a move of nothing moves nothing');
    for (const amountPlur of ['0.5', '-1', '1e16', '01', 1]) {
      assert.ok(refused({ ...depositRequest(), amountPlur }), JSON.stringify(amountPlur));
    }
    for (const direction of ['cashout', 'Deposit', ''])
      assert.ok(refused({ ...depositRequest(), direction }), direction);
    for (const field of ['requestId', 'nodeId', 'direction', 'amountPlur'] as const) {
      const { [field]: _dropped, ...missing } = depositRequest();
      assert.ok(refused(missing), `no ${field}`);
    }
    assert.ok(refused({ ...depositRequest(), requestId: 'not-a-uuid' }));
    assert.ok(refused({ ...depositRequest(), nodeId: 'a/b' }));
  });

  it('drops a field it does not name, so a request cannot name where a withdrawal goes', () => {
    const parsed = fundingChequebookOperationRequestSchema.parse({ ...depositRequest(), to: WALLET, profile: 'x' });
    assert.equal('to' in parsed, false);
    assert.equal('profile' in parsed, false);
  });

  it('answers the request id, the direction, a state and the transaction hash once there is one', () => {
    const answer = { requestId: REQUEST_ID, direction: 'deposit', state: 'submitted', txHash: TX_HASH };
    assert.deepEqual(fundingChequebookOperationAnswerSchema.parse(answer), answer);
    assert.equal(
      fundingChequebookOperationAnswerSchema.parse({ ...answer, state: 'unknown', txHash: null }).txHash,
      null,
    );
    assert.equal(fundingChequebookOperationAnswerSchema.safeParse({ ...answer, direction: 'cashout' }).success, false);
    assert.equal(fundingChequebookOperationAnswerSchema.safeParse({ ...answer, state: 'settled' }).success, false);
  });
});

describe('GET /api/admin-funding/chequebook-operations/:requestId', () => {
  it('answers the state with the hash and the error, each null until there is one, in the four states only', () => {
    const failed = fundingChequebookOperationStatusSchema.parse({
      requestId: REQUEST_ID,
      direction: 'withdraw',
      state: 'failed',
      txHash: null,
      error: 'The chequebook holds less than the withdrawal.',
    });
    assert.equal(failed.error, 'The chequebook holds less than the withdrawal.');
    const confirmed = fundingChequebookOperationStatusSchema.parse({
      ...failed,
      state: 'confirmed',
      txHash: TX_HASH,
      error: null,
    });
    assert.equal(confirmed.txHash, TX_HASH);
    for (const state of ['submitting', 'settled', 'reverted', 'rejected', 'asserted']) {
      assert.equal(fundingChequebookOperationStatusSchema.safeParse({ ...confirmed, state }).success, false, state);
    }
  });

  const submitted = () => ({
    requestId: REQUEST_ID,
    direction: 'withdraw',
    state: 'submitted',
    txHash: TX_HASH,
    error: null,
  });

  it('says whether a submitted move is mined and waits for its block to be final, or not yet', () => {
    assert.deepEqual(fundingChequebookOperationStatusSchema.parse({ ...submitted(), mined: true }), {
      ...submitted(),
      mined: true,
    });
    assert.equal(fundingChequebookOperationStatusSchema.parse({ ...submitted(), mined: false }).mined, false);
  });

  it('takes the answer of a manager that does not say whether the move is mined, with no mined at all', () => {
    const older = fundingChequebookOperationStatusSchema.parse(submitted());
    assert.equal(older.mined, undefined);
    assert.equal('mined' in older, false);
  });

  it('refuses a mined that is not true or false', () => {
    for (const mined of ['true', 1, 0, null, 'yes']) {
      assert.equal(
        fundingChequebookOperationStatusSchema.safeParse({ ...submitted(), mined }).success,
        false,
        JSON.stringify(mined),
      );
    }
  });
});

describe('an error answer', () => {
  it('takes one of the codes and a sentence, and refuses a code it does not know', () => {
    assert.equal(
      fundingErrorAnswerSchema.parse({ error: 'unknown_node', message: 'No such node.' }).error,
      'unknown_node',
    );
    assert.equal(fundingErrorAnswerSchema.safeParse({ error: 'teapot', message: 'no' }).success, false);
  });
});

const CATALOGUE_NODE_ID = 'catalogue:bee-uploader';

const archiveBatch = () => ({
  ...batch(),
  batchId: `0x${'e5'.repeat(32)}`,
  nodeId: CATALOGUE_NODE_ID,
  nodeLabel: 'catalogue',
  label: 'Autumn event',
  writable: true,
});

const purchaseRequest = () => ({
  requestId: REQUEST_ID,
  nodeId: CATALOGUE_NODE_ID,
  depth: 22,
  amountPerChunkPlur: '12441600000',
  label: 'Autumn event',
});

describe('the archive batches, in the inventory', () => {
  it('are absent from the answer of a manager that keeps none, which still parses', () => {
    assert.equal('archiveBatches' in fundingInventorySchema.parse(inventory()), false);
  });

  it('carry each batch with the node that holds it, its readings, its label and whether it can be written', () => {
    const left = {
      ...archiveBatch(),
      batchId: `0x${'F6'.repeat(32)}`,
      nodeId: 'catalogue-old:bee-uploader',
      nodeLabel: 'catalogue-old',
      label: null,
      writable: false,
    };
    const answer = { ...inventory(), archiveBatches: [archiveBatch(), left] };
    assert.deepEqual(fundingInventorySchema.parse(answer).archiveBatches, [
      archiveBatch(),
      { ...left, batchId: left.batchId.toLowerCase() },
    ]);
  });

  it('are listed while no catalogue node is designated, since each still needs its top-ups', () => {
    const answer = { ...inventory(), catalogue: null, archiveBatches: [{ ...archiveBatch(), writable: false }] };
    assert.equal(fundingInventorySchema.parse(answer).archiveBatches!.length, 1);
  });

  it('read an empty list as no archive batches, and hang on no node', () => {
    assert.deepEqual(fundingInventorySchema.parse({ ...inventory(), archiveBatches: [] }).archiveBatches, []);
    assert.equal('archiveBatches' in fundingNodeSchema.parse({ ...node(), archiveBatches: [archiveBatch()] }), false);
  });

  it('hold each to the rules of a batch, with a holding node, a said writability and a label of a length', () => {
    for (const over of [
      { batchId: 'e5'.repeat(32) },
      { nodeId: '' },
      { nodeId: 'catalogue/../x' },
      { nodeLabel: '' },
      { writable: null },
      { label: '' },
      { label: 'x'.repeat(65) },
      { depth: 256 },
      { fillRatio: 1.5 },
    ]) {
      assert.equal(
        fundingArchiveBatchSchema.safeParse({ ...archiveBatch(), ...over }).success,
        false,
        JSON.stringify(over),
      );
    }
    assert.equal(fundingInventorySchema.safeParse({ ...inventory(), archiveBatches: null }).success, false);
  });

  it('drop what a newer manager adds to one, a Bee API address among them', () => {
    const parsed = fundingArchiveBatchSchema.parse({ ...archiveBatch(), beeApiUrl: 'http://bee.example.org:1633' });
    assert.deepEqual(parsed, archiveBatch());
  });

  it('are what a stamp operation names with their own holder, as it names any node and its batch', () => {
    const request = { ...topUpRequest(), nodeId: 'catalogue-old:bee-uploader', batchId: archiveBatch().batchId };
    assert.deepEqual(fundingStampOperationRequestSchema.parse(request), request);
  });
});

describe('POST /api/admin-funding/stamp-purchases', () => {
  it('takes the catalogue node, a depth, an amount for each chunk and a label, the request id in lower case', () => {
    const parsed = fundingStampPurchaseRequestSchema.parse({
      ...purchaseRequest(),
      requestId: REQUEST_ID.toUpperCase(),
    });
    assert.deepEqual(parsed, purchaseRequest());
  });

  it('takes no label, and trims one', () => {
    assert.equal(fundingStampPurchaseRequestSchema.parse({ ...purchaseRequest(), label: null }).label, null);
    assert.equal(fundingStampPurchaseRequestSchema.parse({ ...purchaseRequest(), label: '  Day 2 ' }).label, 'Day 2');
  });

  it('takes every depth the capacity table names, and no other', () => {
    for (const depth of [17, 19, 30, 41]) {
      assert.equal(
        fundingStampPurchaseRequestSchema.safeParse({ ...purchaseRequest(), depth }).success,
        true,
        `${depth}`,
      );
    }
    for (const depth of [0, 16, 42, 22.5, '22']) {
      assert.equal(
        fundingStampPurchaseRequestSchema.safeParse({ ...purchaseRequest(), depth }).success,
        false,
        `${depth}`,
      );
    }
  });

  it('refuses a request that names no node, no amount, or a label that is empty or too long', () => {
    for (const over of [
      { requestId: 'not-a-uuid' },
      { nodeId: '' },
      { nodeId: 'catalogue/../x' },
      { amountPerChunkPlur: '0' },
      { amountPerChunkPlur: '1.5' },
      { amountPerChunkPlur: 12441600000 },
      { label: '   ' },
      { label: 'x'.repeat(65) },
      { label: undefined },
    ]) {
      const request = { ...purchaseRequest(), ...over };
      assert.equal(fundingStampPurchaseRequestSchema.safeParse(request).success, false, JSON.stringify(over));
    }
  });

  it('has no field for mutability, since an archive stamp is always immutable', () => {
    const parsed = fundingStampPurchaseRequestSchema.parse({ ...purchaseRequest(), immutable: false });
    assert.equal('immutable' in parsed, false);
  });

  it('answers the state, and the batch and its transaction once the node has answered', () => {
    const waiting = { requestId: REQUEST_ID, state: 'unknown', batchId: null, txHash: null };
    assert.deepEqual(fundingStampPurchaseAnswerSchema.parse(waiting), waiting);
    const bought = { requestId: REQUEST_ID, state: 'confirmed', batchId: BATCH_ID, txHash: TX_HASH };
    assert.deepEqual(
      fundingStampPurchaseAnswerSchema.parse({ ...bought, batchId: BATCH_ID.toUpperCase().replace('0X', '0x') }),
      bought,
    );
    assert.equal(fundingStampPurchaseAnswerSchema.safeParse({ ...bought, state: 'bought' }).success, false);
    assert.equal(fundingStampPurchaseAnswerSchema.safeParse({ ...bought, batchId: 'c3'.repeat(32) }).success, false);
  });
});

describe('GET /api/admin-funding/stamp-purchases/:requestId', () => {
  const status = () => ({
    requestId: REQUEST_ID,
    state: 'confirmed',
    batchId: BATCH_ID,
    txHash: TX_HASH,
    usable: false,
    error: null,
  });

  it('says where the purchase stands and whether the batch can stamp yet', () => {
    assert.deepEqual(fundingStampPurchaseStatusSchema.parse(status()), status());
    assert.equal(fundingStampPurchaseStatusSchema.parse({ ...status(), usable: true }).usable, true);
  });

  it('has no batch, hash or word about it before the node answered, and an error when it failed', () => {
    const unknown = { ...status(), state: 'unknown', batchId: null, txHash: null, usable: null };
    assert.deepEqual(fundingStampPurchaseStatusSchema.parse(unknown), unknown);
    const failed = { ...unknown, state: 'failed', error: 'The node did not answer.' };
    assert.deepEqual(fundingStampPurchaseStatusSchema.parse(failed), failed);
  });

  it('refuses an answer without a said usability or error, and drops what a newer manager adds', () => {
    const { usable: _usable, ...withoutUsable } = status();
    assert.equal(fundingStampPurchaseStatusSchema.safeParse(withoutUsable).success, false);
    const { error: _error, ...withoutError } = status();
    assert.equal(fundingStampPurchaseStatusSchema.safeParse(withoutError).success, false);
    assert.deepEqual(fundingStampPurchaseStatusSchema.parse({ ...status(), beeApiUrl: 'http://bee:1633' }), status());
  });
});

describe('a chequebook operation on the catalogue node', () => {
  it('is a request as any other, which the manager takes for the catalogue node since it copies recordings', () => {
    const request = { ...depositRequest(), nodeId: CATALOGUE_NODE_ID };
    assert.deepEqual(fundingChequebookOperationRequestSchema.parse(request), request);
  });
});

describe("the manager's API token", () => {
  const TOKEN = 'a'.repeat(40);
  const FORMER = 'b'.repeat(40);

  it('has one name in the manager and in the admin, and each app an earlier name of its own', () => {
    assert.equal(MANAGER_API_TOKEN_KEY, 'MANAGER_API_TOKEN');
    assert.equal(MANAGER_API_TOKEN_FORMER_KEY_IN_MANAGER, 'FUNDING_API_TOKEN');
    assert.equal(MANAGER_API_TOKEN_FORMER_KEY_IN_ADMIN, 'MANAGER_FUNDING_TOKEN');
  });

  it('is read under its own name first, and under the earlier name when that one is unset or only spaces', () => {
    const both = { MANAGER_API_TOKEN: TOKEN, FUNDING_API_TOKEN: FORMER };
    assert.deepEqual(managerApiTokenFrom(both, MANAGER_API_TOKEN_FORMER_KEY_IN_MANAGER), {
      key: 'MANAGER_API_TOKEN',
      value: TOKEN,
    });
    assert.deepEqual(managerApiTokenFrom({ FUNDING_API_TOKEN: FORMER }, MANAGER_API_TOKEN_FORMER_KEY_IN_MANAGER), {
      key: 'FUNDING_API_TOKEN',
      value: FORMER,
    });
    assert.deepEqual(
      managerApiTokenFrom(
        { MANAGER_API_TOKEN: '   ', MANAGER_FUNDING_TOKEN: ` ${FORMER} ` },
        MANAGER_API_TOKEN_FORMER_KEY_IN_ADMIN,
      ),
      { key: 'MANAGER_FUNDING_TOKEN', value: FORMER },
    );
  });

  it("is none when neither name is set, and never read under the other app's earlier name", () => {
    assert.equal(managerApiTokenFrom({}, MANAGER_API_TOKEN_FORMER_KEY_IN_ADMIN), null);
    assert.equal(managerApiTokenFrom({ FUNDING_API_TOKEN: FORMER }, MANAGER_API_TOKEN_FORMER_KEY_IN_ADMIN), null);
    assert.equal(managerApiTokenFrom({ MANAGER_FUNDING_TOKEN: FORMER }, MANAGER_API_TOKEN_FORMER_KEY_IN_MANAGER), null);
  });
});

describe('a batch purchase', () => {
  const RUNG_NODE_ID = 'pool-360p:bee-rung';
  const OLD_BATCH_ID = `0x${'d4'.repeat(32)}`;
  const OTHER_STAGE_ID = '1c9a7b4f-3d5e-4f6a-9bac-2d3e4f5a6b7c';

  const rungRequest = () => ({
    requestId: REQUEST_ID,
    purpose: 'rung',
    nodeId: RUNG_NODE_ID,
    depth: 22,
    amountPerChunkPlur: '414720000',
    immutable: false,
    label: null,
    replacesBatchId: OLD_BATCH_ID,
  });
  const catalogueRequest = () => ({
    ...rungRequest(),
    purpose: 'catalogue',
    nodeId: CATALOGUE_NODE_ID,
    depth: 18,
    immutable: true,
  });
  const archiveRequest = () => ({
    ...catalogueRequest(),
    purpose: 'archive',
    depth: 24,
    label: 'Day 2',
    replacesBatchId: null,
  });
  const rungStatus = () => ({
    requestId: REQUEST_ID,
    purpose: 'rung',
    nodeId: RUNG_NODE_ID,
    state: 'confirmed',
    batchId: BATCH_ID,
    txHash: TX_HASH,
    usable: true,
    step: 'set',
    error: null,
    stages: [
      { stageId: STAGE_ID, name: 'main stage', apply: 'applied', message: null },
      { stageId: OTHER_STAGE_ID, name: 'second stage', apply: 'waiting_live', message: null },
    ],
    catalogue: null,
  });

  it('has one route for every purpose, and its three follow-up calls under the purchase', () => {
    assert.equal(FUNDING_BATCH_PURCHASES_PATH, `${ADMIN_FUNDING_PATH}/batch-purchases`);
    assert.deepEqual([...FUNDING_BATCH_PURCHASE_PURPOSES], ['rung', 'catalogue', 'archive']);
    const path = `${FUNDING_BATCH_PURCHASES_PATH}/${REQUEST_ID}`;
    assert.equal(fundingBatchPurchasePath(REQUEST_ID.toUpperCase()), path);
    assert.equal(fundingBatchPurchaseRestartPath(REQUEST_ID), `${path}/restart`);
    assert.equal(fundingBatchPurchaseCheckPath(REQUEST_ID), `${path}/check`);
    assert.equal(fundingBatchPurchaseReleasePath(REQUEST_ID), `${path}/release`);
    for (const bad of ['', 'not-a-uuid', `${REQUEST_ID}/x`, '../inventory']) {
      assert.throws(() => fundingBatchPurchasePath(bad), /UUID/);
      assert.throws(() => fundingBatchPurchaseRestartPath(bad), /UUID/);
    }
    assert.notEqual(FUNDING_BATCH_PURCHASES_PATH, FUNDING_STAMP_PURCHASES_PATH);
  });

  it('takes the same fields for a rung, the catalogue and an archive stamp', () => {
    assert.deepEqual(fundingBatchPurchaseRequestSchema.parse(rungRequest()), rungRequest());
    assert.deepEqual(fundingBatchPurchaseRequestSchema.parse(catalogueRequest()), catalogueRequest());
    assert.deepEqual(fundingBatchPurchaseRequestSchema.parse(archiveRequest()), archiveRequest());
    const upper = {
      ...rungRequest(),
      requestId: REQUEST_ID.toUpperCase(),
      replacesBatchId: OLD_BATCH_ID.toUpperCase(),
    };
    assert.deepEqual(
      fundingBatchPurchaseRequestSchema.parse({ ...upper, replacesBatchId: `0x${'D4'.repeat(32)}` }),
      rungRequest(),
    );
    assert.equal(
      fundingBatchPurchaseRequestSchema.parse({ ...rungRequest(), replacesBatchId: null }).replacesBatchId,
      null,
    );
    assert.equal(fundingBatchPurchaseRequestSchema.parse({ ...rungRequest(), label: ' 360p ' }).label, '360p');
  });

  it('buys a rung batch of depth 17 to 40, of either kind', () => {
    for (const depth of [17, 22, 40]) {
      assert.equal(fundingBatchPurchaseRequestSchema.safeParse({ ...rungRequest(), depth }).success, true, `${depth}`);
    }
    for (const depth of [16, 41, 22.5]) {
      assert.equal(fundingBatchPurchaseRequestSchema.safeParse({ ...rungRequest(), depth }).success, false, `${depth}`);
    }
    assert.equal(fundingBatchPurchaseRequestSchema.safeParse({ ...rungRequest(), immutable: true }).success, true);
  });

  it('buys a catalogue batch of depth 18 to 40, immutable only', () => {
    for (const depth of [18, 40]) {
      assert.equal(fundingBatchPurchaseRequestSchema.safeParse({ ...catalogueRequest(), depth }).success, true);
    }
    for (const depth of [17, 41]) {
      assert.equal(fundingBatchPurchaseRequestSchema.safeParse({ ...catalogueRequest(), depth }).success, false);
    }
    assert.equal(
      fundingBatchPurchaseRequestSchema.safeParse({ ...catalogueRequest(), immutable: false }).success,
      false,
    );
  });

  it('buys an archive stamp of a depth of the capacity table, immutable, replacing none', () => {
    for (const depth of [17, 41]) {
      assert.equal(fundingBatchPurchaseRequestSchema.safeParse({ ...archiveRequest(), depth }).success, true);
    }
    assert.equal(fundingBatchPurchaseRequestSchema.safeParse({ ...archiveRequest(), depth: 42 }).success, false);
    assert.equal(fundingBatchPurchaseRequestSchema.safeParse({ ...archiveRequest(), immutable: false }).success, false);
    assert.equal(
      fundingBatchPurchaseRequestSchema.safeParse({ ...archiveRequest(), replacesBatchId: OLD_BATCH_ID }).success,
      false,
    );
  });

  it('refuses a purpose it does not know, no amount, and a request without a said kind or replaced batch', () => {
    assert.equal(fundingBatchPurchaseRequestSchema.safeParse({ ...rungRequest(), purpose: 'gateway' }).success, false);
    assert.equal(
      fundingBatchPurchaseRequestSchema.safeParse({ ...rungRequest(), amountPerChunkPlur: '0' }).success,
      false,
    );
    const { immutable: _immutable, ...withoutKind } = rungRequest();
    assert.equal(fundingBatchPurchaseRequestSchema.safeParse(withoutKind).success, false);
    const { replacesBatchId: _replaces, ...withoutReplaced } = rungRequest();
    assert.equal(fundingBatchPurchaseRequestSchema.safeParse(withoutReplaced).success, false);
  });

  it('is answered with its purpose and its state, and with the batch once the node gave one', () => {
    const answer = { requestId: REQUEST_ID, purpose: 'rung', state: 'unknown', batchId: null, txHash: null };
    assert.deepEqual(fundingBatchPurchaseAnswerSchema.parse(answer), answer);
    const bought = { ...answer, state: 'confirmed', batchId: BATCH_ID, txHash: TX_HASH };
    assert.deepEqual(fundingBatchPurchaseAnswerSchema.parse(bought), bought);
  });

  it('says its step, and for a rung each following stage and where its restart stands', () => {
    assert.deepEqual([...FUNDING_PURCHASE_STEPS], ['buying', 'waiting_usable', 'set', 'done', 'failed']);
    assert.deepEqual(fundingBatchPurchaseStatusSchema.parse(rungStatus()), rungStatus());
    for (const apply of FUNDING_PURCHASE_APPLY_STATES) {
      const status = { ...rungStatus(), stages: [{ stageId: STAGE_ID, name: 'main stage', apply, message: null }] };
      assert.deepEqual(fundingBatchPurchaseStatusSchema.parse(status), status);
    }
    const unknownApply = {
      ...rungStatus(),
      stages: [{ stageId: STAGE_ID, name: 'main stage', apply: 'paused', message: null }],
    };
    assert.equal(fundingBatchPurchaseStatusSchema.safeParse(unknownApply).success, false);
  });

  it('says for the catalogue which batch it moved from and whether that one is released', () => {
    const designated = {
      ...rungStatus(),
      purpose: 'catalogue',
      nodeId: CATALOGUE_NODE_ID,
      stages: [],
      catalogue: { previousBatchId: OLD_BATCH_ID, released: false },
    };
    assert.deepEqual(fundingBatchPurchaseStatusSchema.parse(designated), designated);
    const first = { ...designated, step: 'done', catalogue: { previousBatchId: null, released: false } };
    assert.deepEqual(fundingBatchPurchaseStatusSchema.parse(first), first);
  });

  it('has no batch, stage or catalogue word before the node answered, and an error when it failed', () => {
    const buying = {
      ...rungStatus(),
      state: 'unknown',
      batchId: null,
      txHash: null,
      usable: null,
      step: 'buying',
      stages: [],
    };
    assert.deepEqual(fundingBatchPurchaseStatusSchema.parse(buying), buying);
    const failed = { ...buying, state: 'failed', step: 'failed', error: 'The node did not answer.' };
    assert.deepEqual(fundingBatchPurchaseStatusSchema.parse(failed), failed);
    const late = {
      ...rungStatus(),
      usable: false,
      step: 'failed',
      error: 'The batch was not usable after an hour.',
      stages: [],
    };
    assert.deepEqual(fundingBatchPurchaseStatusSchema.parse(late), late);
  });

  it('drops what a newer manager adds, a node address among it', () => {
    assert.deepEqual(
      fundingBatchPurchaseStatusSchema.parse({ ...rungStatus(), beeApiUrl: 'http://bee:1633' }),
      rungStatus(),
    );
  });

  it('can be restarted only on a stage that waits for a broadcast, and is over on three states', () => {
    const restartable = FUNDING_PURCHASE_APPLY_STATES.filter(fundingPurchaseRestartable);
    assert.deepEqual(restartable, ['waiting_live', 'waiting_unknown']);
    const settled = FUNDING_PURCHASE_APPLY_STATES.filter(fundingPurchaseApplySettled);
    assert.deepEqual(settled, ['applied', 'not_following', 'stopped']);
    assert.deepEqual(fundingBatchPurchaseRestartRequestSchema.parse({ stageId: STAGE_ID.toUpperCase() }), {
      stageId: STAGE_ID,
    });
    assert.equal(fundingBatchPurchaseRestartRequestSchema.safeParse({}).success, false);
  });
});

describe('what the inventory says for a purchase', () => {
  it("carries the manager's verdict on a batch, and parses the answer of a manager that gives none", () => {
    for (const state of ['expired', 'gone', 'active', 'full', 'pending', 'unknown', 'none']) {
      assert.equal(fundingBatchSchema.parse({ ...batch(), state }).state, state);
    }
    assert.equal(fundingBatchSchema.parse(batch()).state, undefined);
    assert.equal(fundingBatchSchema.safeParse({ ...batch(), state: 'lost' }).success, false);
  });

  it('carries the depth and kind a replacement opens with, null for a gateway, absent from an older manager', () => {
    const replacement = { depth: 22, immutable: false };
    assert.deepEqual(fundingNodeSchema.parse({ ...node(), replacement }).replacement, replacement);
    assert.equal(fundingNodeSchema.parse({ ...node(), replacement: null }).replacement, null);
    assert.equal(fundingNodeSchema.parse(node()).replacement, undefined);
    assert.equal(
      fundingNodeSchema.safeParse({ ...node(), replacement: { depth: 16, immutable: true } }).success,
      false,
    );
    assert.equal(
      fundingNodeSchema.safeParse({ ...node(), replacement: { depth: 41, immutable: true } }).success,
      false,
    );
  });
});
