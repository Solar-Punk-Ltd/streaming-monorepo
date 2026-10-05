import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FUNDING_ITEM_STATES,
  FUNDING_PATH,
  FUNDING_PIN_STATES,
  FUNDING_PINS_PATH,
  FUNDING_TRANSFERS_ADMIN_PATH,
  XBZZ_DECIMALS,
  XDAI_DECIMALS,
  formatBaseUnits,
  type FundingTransferItem,
  type FundingView,
  fundingBulkPath,
  parseBaseUnits,
  sumBaseUnits,
} from './funding.js';

const BULK_ID = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';

describe('the console routes', () => {
  it('names the paths and builds the bulk query from a UUID alone', () => {
    assert.equal(FUNDING_PATH, '/api/funding');
    assert.equal(FUNDING_PINS_PATH, '/api/funding/pins');
    assert.equal(FUNDING_TRANSFERS_ADMIN_PATH, '/api/funding/transfers');
    assert.equal(fundingBulkPath(BULK_ID.toUpperCase()), `/api/funding/transfers?bulkId=${BULK_ID}`);
    assert.throws(() => fundingBulkPath('x&y=1'), /UUID/);
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
  it('name the open send on the Funding page, so a reload resumes it', () => {
    const view: FundingView = {
      configured: true,
      wallet: null,
      chainId: 100,
      stages: [],
      catalogue: null,
      observedAt: null,
      managerError: null,
      openBulkId: BULK_ID,
    };
    const idle: FundingView = { ...view, openBulkId: null };

    assert.equal(view.openBulkId, BULK_ID);
    assert.equal(idle.openBulkId, null);
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
    };
    const reverted: FundingTransferItem = { ...refused, blockNumber: 12, error: 'The transaction reverted on chain.' };

    assert.equal(refused.blockNumber, null);
    assert.equal(reverted.blockNumber, 12);
  });
});
