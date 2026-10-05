import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ADMIN_FUNDING_PATH,
  FUNDING_ERROR_CODES,
  FUNDING_ERROR_STATUS,
  FUNDING_INVENTORY_PATH,
  FUNDING_NODE_ROLES,
  FUNDING_TRANSFER_KINDS,
  FUNDING_TRANSFER_STATES,
  FUNDING_TRANSFERS_PATH,
  fundingAccountAnswerSchema,
  fundingAccountPath,
  fundingErrorAnswerSchema,
  fundingInventorySchema,
  fundingNodeSchema,
  fundingTransferAnswerSchema,
  fundingTransferPath,
  fundingTransferRequestSchema,
  fundingTransferStatusSchema,
} from './funding.js';

const STAGE_ID = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const REQUEST_ID = '7d1e2f3a-4b5c-4d6e-9f0a-b1c2d3e4f5a6';
const WALLET = '0x1111111111111111111111111111111111111111';
const BRAND = '0x2222222222222222222222222222222222222222';
const BZZ_TOKEN = '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';
const TX_HASH = `0x${'ab'.repeat(32)}`;

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
});

describe('the closed lists', () => {
  it('names the roles, kinds, states and error codes the plan names, and a status for each code', () => {
    assert.deepEqual(FUNDING_NODE_ROLES, ['uploader', 'gateway', 'rung']);
    assert.deepEqual(FUNDING_TRANSFER_KINDS, ['xdai', 'xbzz']);
    assert.deepEqual(FUNDING_TRANSFER_STATES, ['submitted', 'confirmed', 'failed', 'unknown']);
    assert.deepEqual(FUNDING_ERROR_CODES, [
      'funding_off',
      'unauthorized',
      'unknown_node',
      'bad_transaction',
      'chain_unreachable',
      'conflict',
    ]);
    assert.deepEqual(Object.keys(FUNDING_ERROR_STATUS).sort(), [...FUNDING_ERROR_CODES].sort());
    assert.equal(FUNDING_ERROR_STATUS.funding_off, 404, 'an API that is off looks like no API');
    assert.equal(FUNDING_ERROR_STATUS.unauthorized, 401);
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

describe('an error answer', () => {
  it('takes one of the codes and a sentence, and refuses a code it does not know', () => {
    assert.equal(
      fundingErrorAnswerSchema.parse({ error: 'unknown_node', message: 'No such node.' }).error,
      'unknown_node',
    );
    assert.equal(fundingErrorAnswerSchema.safeParse({ error: 'teapot', message: 'no' }).success, false);
  });
});
