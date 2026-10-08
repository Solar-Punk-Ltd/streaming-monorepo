import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type AdminFundingNode,
  FUNDING_CHEQUEBOOK_DIRECTIONS,
  FUNDING_CHEQUEBOOK_OPERATIONS_ADMIN_PATH,
  FUNDING_ITEM_STATES,
  FUNDING_PATH,
  FUNDING_PIN_STATES,
  FUNDING_PINS_PATH,
  FUNDING_STAMP_OPERATION_KINDS,
  FUNDING_STAMP_OPERATIONS_ADMIN_PATH,
  FUNDING_TRANSFERS_ADMIN_PATH,
  XBZZ_DECIMALS,
  XDAI_DECIMALS,
  formatBaseUnits,
  type FundingStampItem,
  type FundingStampOperationsRequest,
  type FundingTransferItem,
  type FundingView,
  fundingBulkPath,
  fundingChequebookBulkPath,
  fundingStampBulkPath,
  parseBaseUnits,
  type StampOperationItemRequest,
  sumBaseUnits,
} from './funding.js';

const BULK_ID = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const BATCH_ID = `0x${'c3'.repeat(32)}`;

describe('the console routes', () => {
  it('names the paths and builds the bulk query from a UUID alone', () => {
    assert.equal(FUNDING_PATH, '/api/funding');
    assert.equal(FUNDING_PINS_PATH, '/api/funding/pins');
    assert.equal(FUNDING_TRANSFERS_ADMIN_PATH, '/api/funding/transfers');
    assert.equal(fundingBulkPath(BULK_ID.toUpperCase()), `/api/funding/transfers?bulkId=${BULK_ID}`);
    assert.throws(() => fundingBulkPath('x&y=1'), /UUID/);
  });

  it('names the stamp operations path and builds its bulk query from a UUID alone', () => {
    assert.equal(FUNDING_STAMP_OPERATIONS_ADMIN_PATH, '/api/funding/stamp-operations');
    assert.equal(fundingStampBulkPath(BULK_ID.toUpperCase()), `/api/funding/stamp-operations?bulkId=${BULK_ID}`);
    for (const bad of ['', 'x&y=1', `${BULK_ID}&bulkId=other`]) {
      assert.throws(() => fundingStampBulkPath(bad), /UUID/, JSON.stringify(bad));
    }
  });

  it('names the two stamp operations, as the manager does', () => {
    assert.deepEqual(FUNDING_STAMP_OPERATION_KINDS, ['topup', 'dilute']);
  });

  it('names the chequebook bulk path under the Funding page, from a UUID in lower case', () => {
    assert.equal(FUNDING_CHEQUEBOOK_OPERATIONS_ADMIN_PATH, '/api/funding/chequebook-operations');
    assert.equal(
      fundingChequebookBulkPath(BULK_ID.toUpperCase()),
      `/api/funding/chequebook-operations?bulkId=${BULK_ID}`,
    );
    for (const bad of ['', 'x&y=1', `${BULK_ID}&bulkId=other`]) {
      assert.throws(() => fundingChequebookBulkPath(bad), /UUID/, JSON.stringify(bad));
    }
  });

  it('names the two ways a chequebook operation moves xBZZ, as the manager does', () => {
    assert.deepEqual(FUNDING_CHEQUEBOOK_DIRECTIONS, ['deposit', 'withdraw']);
  });

  it('names the pin and item states', () => {
    assert.deepEqual(FUNDING_PIN_STATES, ['pinned', 'new', 'changed']);
    assert.deepEqual(FUNDING_ITEM_STATES, ['queued', 'submitted', 'confirmed', 'failed', 'unknown']);
  });
});

describe('base units', () => {
  it('knows xDAI has 18 decimals and xBZZ 16', () => {
    assert.equal(XDAI_DECIMALS, 18);
    assert.equal(XBZZ_DECIMALS, 16);
  });

  it('reads a typed amount into base units exactly, without a float', () => {
    assert.equal(parseBaseUnits('1', XDAI_DECIMALS), '1000000000000000000');
    assert.equal(parseBaseUnits('0.25', XDAI_DECIMALS), '250000000000000000');
    assert.equal(parseBaseUnits('0.1', XBZZ_DECIMALS), '1000000000000000');
    assert.equal(parseBaseUnits('  12.5  ', XBZZ_DECIMALS), '125000000000000000');
    assert.equal(parseBaseUnits('0.000000000000000001', XDAI_DECIMALS), '1');
    assert.equal(parseBaseUnits('123456789.123456789', XDAI_DECIMALS), '123456789123456789000000000');
    assert.equal(parseBaseUnits('0', XDAI_DECIMALS), '0');
    assert.equal(parseBaseUnits('.5', XDAI_DECIMALS), '500000000000000000');
  });

  it('refuses what is not an amount, and more decimals than the token has', () => {
    for (const bad of ['', '-1', '1e18', 'abc', '1.2.3', '1,5', '.', '0x10']) {
      assert.equal(parseBaseUnits(bad, XDAI_DECIMALS), null, JSON.stringify(bad));
    }
    assert.equal(parseBaseUnits('0.00000000000000001', XBZZ_DECIMALS), null, '17 decimals of a 16-decimal token');
  });

  it('prints base units as an amount, with the trailing zeros of the fraction dropped', () => {
    assert.equal(formatBaseUnits('1000000000000000000', XDAI_DECIMALS), '1');
    assert.equal(formatBaseUnits('250000000000000000', XDAI_DECIMALS), '0.25');
    assert.equal(formatBaseUnits('1', XDAI_DECIMALS), '0.000000000000000001');
    assert.equal(formatBaseUnits('0', XBZZ_DECIMALS), '0');
    assert.equal(formatBaseUnits('125000000000000000', XBZZ_DECIMALS), '12.5');
    assert.equal(formatBaseUnits('123456789123456789000000000', XDAI_DECIMALS), '123456789.123456789');
  });

  it('prints and reads back the same base units', () => {
    for (const amount of ['1', '10', '999999999999999999', '1000000000000000001', '42000000000000000000000']) {
      assert.equal(parseBaseUnits(formatBaseUnits(amount, XDAI_DECIMALS), XDAI_DECIMALS), amount);
    }
  });

  it('refuses base units that are not decimal digits, rather than reading them as BigInt would', () => {
    for (const bad of ['', ' 1 ', '0x10', '-5', '1e3', '01', '1.5', '9'.repeat(79)]) {
      assert.throws(() => formatBaseUnits(bad, XDAI_DECIMALS), /base units/, JSON.stringify(bad));
      assert.throws(() => sumBaseUnits(['10', bad]), /base units/, JSON.stringify(bad));
    }
    assert.equal(formatBaseUnits('9'.repeat(78), 0), '9'.repeat(78), '78 digits is the most a 256-bit number has');
  });

  it('reads no typed amount past 78 digits of base units, as the contract refuses one', () => {
    assert.equal(parseBaseUnits('9'.repeat(60), XDAI_DECIMALS), '9'.repeat(60) + '0'.repeat(18));
    assert.equal(parseBaseUnits('9'.repeat(61), XDAI_DECIMALS), null);
  });

  it('adds base units exactly, past what a number holds', () => {
    assert.equal(sumBaseUnits([]), '0');
    assert.equal(sumBaseUnits(['900000000000000000', '200000000000000000']), '1100000000000000000');
    assert.equal(sumBaseUnits(['9007199254740993', '1']), '9007199254740994');
  });
});

describe('the answers', () => {
  const view: FundingView = {
    configured: true,
    wallet: null,
    chainId: 100,
    stages: [],
    catalogue: null,
    postage: null,
    observedAt: null,
    managerError: null,
    openBulkId: BULK_ID,
    openStampBulkId: null,
    openChequebookBulkId: null,
  };

  it('name the open send on the Funding page, so a reload resumes it', () => {
    const idle: FundingView = { ...view, openBulkId: null };

    assert.equal(view.openBulkId, BULK_ID);
    assert.equal(idle.openBulkId, null);
  });

  it('name the open stamp bulk apart from the open send, and the price of postage once a node answered', () => {
    const stamping: FundingView = {
      ...view,
      openBulkId: null,
      openStampBulkId: BULK_ID,
      postage: { pricePerChunkPerBlockPlur: '24000', blockSeconds: 5, minimumValidityBlocks: 17280 },
    };

    assert.equal(stamping.openStampBulkId, BULK_ID);
    assert.equal(stamping.openBulkId, null);
    assert.equal(stamping.postage?.blockSeconds, 5);
    assert.equal(view.postage, null, 'no node answered');
  });

  it("carry a node's batch through, and none for a gateway", () => {
    const node: AdminFundingNode = {
      nodeId: 'stage-1:bee',
      label: 'stage-1-uploader',
      role: 'uploader',
      walletAddress: '0x1111111111111111111111111111111111111111',
      xdaiWei: '1',
      xbzzPlur: '1',
      readError: null,
      batch: {
        batchId: BATCH_ID,
        depth: 22,
        immutable: true,
        usable: true,
        ttlSeconds: 86_400,
        fillRatio: 0.5,
        readError: null,
      },
      pin: 'pinned',
      pinnedAddress: '0x1111111111111111111111111111111111111111',
    };
    const gateway: AdminFundingNode = { ...node, role: 'gateway', batch: null };

    assert.equal(node.batch?.depth, 22);
    assert.equal(gateway.batch, null);
  });

  it('take one kind of stamp operation per item, a top-up in days and a dilution in one step or two', () => {
    const topUp: StampOperationItemRequest = {
      kind: 'topup',
      nodeId: 'stage-1:bee',
      batchId: BATCH_ID,
      expectedDepth: 22,
      days: 30,
      pricePerChunkPerBlockPlur: '24000',
    };
    // @ts-expect-error: a top-up names the price of postage the page quoted it at.
    const unpriced: StampOperationItemRequest = {
      kind: 'topup',
      nodeId: 'stage-1:bee',
      batchId: BATCH_ID,
      expectedDepth: 22,
      days: 30,
    };
    const dilute: StampOperationItemRequest = {
      kind: 'dilute',
      nodeId: 'stage-1:bee',
      batchId: BATCH_ID,
      expectedDepth: 22,
      steps: 2,
    };
    // @ts-expect-error: a dilution takes one step or two, never three.
    const threeSteps: StampOperationItemRequest = { ...dilute, steps: 3 };
    // @ts-expect-error: a top-up names its days, not steps.
    const topUpInSteps: StampOperationItemRequest = { ...topUp, steps: 1 };
    const request: FundingStampOperationsRequest = { items: [topUp, dilute] };

    assert.deepEqual(
      request.items.map((item) => item.kind),
      ['topup', 'dilute'],
    );
    assert.equal(dilute.kind === 'dilute' && dilute.steps, 2);
    assert.ok(threeSteps && topUpInSteps && unpriced, 'the compiler refuses all three, so none is read further');
  });

  it("carry a top-up's days and cost and a dilution's steps, each null for the other kind", () => {
    const topUp: FundingStampItem = {
      requestId: BULK_ID,
      kind: 'topup',
      nodeId: 'stage-1:bee',
      nodeLabel: 'stage-1-uploader',
      batchId: BATCH_ID,
      days: 30,
      steps: null,
      // 30 days at 24000 PLUR a chunk a block, 12441600000 a chunk, for the 2^22 chunks of a depth 22 batch.
      costPlur: '52183852646400000',
      state: 'confirmed',
      txHash: `0x${'ab'.repeat(32)}`,
      error: null,
      settled: true,
      watched: false,
    };
    const dilute: FundingStampItem = { ...topUp, kind: 'dilute', days: null, steps: 1, costPlur: null };

    assert.equal(topUp.steps, null);
    assert.equal(dilute.days, null);
    assert.equal(dilute.costPlur, null, 'a dilution costs gas alone');
  });

  it("carry an item's block, null until it is mined, so a refusal at the relay reads apart from a revert", () => {
    const refused: FundingTransferItem = {
      requestId: BULK_ID,
      nodeId: 'stage-1:uploader',
      kind: 'xdai',
      amount: '1',
      state: 'failed',
      txHash: null,
      blockNumber: null,
      error: "The chain's node refused it.",
      settled: true,
      watched: true,
    };
    const reverted: FundingTransferItem = {
      ...refused,
      blockNumber: 12,
      error: 'The transaction reverted on chain.',
      watched: false,
    };

    assert.equal(refused.blockNumber, null);
    assert.equal(reverted.blockNumber, 12);
    assert.equal(refused.watched, true, 'a refusal at the relay is watched for a late receipt');
    assert.equal(reverted.watched, false, 'a revert is final');
  });
});
