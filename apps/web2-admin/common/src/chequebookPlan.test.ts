import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHEQUEBOOK_TARGET_MIN_PLUR,
  chequebookMove,
  chequebookUncashedPlur,
  movableChequebook,
} from './chequebookPlan.js';
import { type FundingChequebook, type FundingNode, parseBaseUnits, XBZZ_DECIMALS } from './funding.js';

const xbzz = (amount: string) => parseBaseUnits(amount, XBZZ_DECIMALS) as string;

const chequebook = (over: Partial<FundingChequebook> = {}): FundingChequebook => ({
  address: '0x3333333333333333333333333333333333333333',
  availablePlur: xbzz('1.5'),
  totalPlur: xbzz('2'),
  readError: null,
  ...over,
});

const node = (over: Partial<FundingNode> = {}): FundingNode => ({
  nodeId: 'stage-1:bee-uploader',
  label: 'Main stage Bee node',
  role: 'uploader',
  walletAddress: '0x1111111111111111111111111111111111111111',
  xdaiWei: '250000000000000000',
  xbzzPlur: xbzz('3'),
  readError: null,
  chequebook: chequebook(),
  ...over,
});

describe('the least a chequebook is brought to', () => {
  it('is 1 xBZZ', () => {
    assert.equal(CHEQUEBOOK_TARGET_MIN_PLUR, xbzz('1'));
  });
});

describe('what brings a chequebook to the target', () => {
  it('deposits the difference into a chequebook under the target', () => {
    assert.deepEqual(chequebookMove(xbzz('2'), xbzz('1.5')), { direction: 'deposit', amountPlur: xbzz('0.5') });
    assert.deepEqual(chequebookMove(xbzz('1'), '0'), { direction: 'deposit', amountPlur: xbzz('1') });
  });

  it('withdraws the difference from a chequebook over the target', () => {
    assert.deepEqual(chequebookMove(xbzz('1'), xbzz('3.25')), { direction: 'withdraw', amountPlur: xbzz('2.25') });
  });

  it('moves nothing for a chequebook at the target', () => {
    assert.equal(chequebookMove(xbzz('2'), xbzz('2')), null);
  });

  it('keeps every PLUR, past what a floating point number holds', () => {
    assert.deepEqual(chequebookMove('90071992547409931', '1'), {
      direction: 'deposit',
      amountPlur: '90071992547409930',
    });
    assert.deepEqual(chequebookMove(xbzz('1'), '10000000000000001'), { direction: 'withdraw', amountPlur: '1' });
  });

  it('throws on what is not a whole number of PLUR, which the page and the routes refuse first', () => {
    for (const bad of ['', '-1', '1.5', '01', '1e16', ' 1']) {
      assert.throws(() => chequebookMove(bad, '0'), RangeError, `target ${JSON.stringify(bad)}`);
      assert.throws(() => chequebookMove('0', bad), RangeError, `available ${JSON.stringify(bad)}`);
    }
  });
});

describe('the cheques a chequebook owes its peers', () => {
  it('is the total less the available balance', () => {
    assert.equal(chequebookUncashedPlur(chequebook()), xbzz('0.5'));
    assert.equal(chequebookUncashedPlur(chequebook({ availablePlur: xbzz('2') })), '0');
  });

  it('is not known when a balance was not read, or the two do not add up', () => {
    assert.equal(chequebookUncashedPlur(chequebook({ totalPlur: null })), null);
    assert.equal(chequebookUncashedPlur(chequebook({ availablePlur: null })), null);
    assert.equal(chequebookUncashedPlur(chequebook({ availablePlur: xbzz('2.5') })), null);
  });
});

describe('a chequebook the Chequebooks tab moves', () => {
  it("is a stage's own Bee node's or a rung's, with its wallet and its chequebook read", () => {
    assert.equal(movableChequebook(node()), true);
    assert.equal(movableChequebook(node({ role: 'rung' })), true);
  });

  it("is never a gateway's, which the manager does not move", () => {
    assert.equal(movableChequebook(node({ role: 'gateway' })), false);
  });

  it('is none that was not read, none the node has not got, and none from a manager that reads none', () => {
    assert.equal(movableChequebook(node({ chequebook: null })), false);
    assert.equal(movableChequebook(node({ chequebook: undefined })), false);
    const unread = chequebook({ address: null, availablePlur: null, totalPlur: null, readError: 'No answer.' });
    assert.equal(movableChequebook(node({ chequebook: unread })), false);
  });

  it("is none whose node's wallet was not read, since the move is paid from it or into it", () => {
    assert.equal(movableChequebook(node({ walletAddress: null, xdaiWei: null, xbzzPlur: null })), false);
    assert.equal(movableChequebook(node({ xdaiWei: null })), false);
  });
});
