import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHEQUEBOOK_TARGET_MIN_PLUR,
  type ChequebookMove,
  chequebookMove,
  chequebookMoveNow,
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

/** Where a move leaves a chequebook whose available balance is `nowPlur`, in PLUR. */
function landing(nowPlur: string, move: ChequebookMove): string {
  const now = BigInt(nowPlur);
  const amount = BigInt(move.amountPlur);
  return (move.direction === 'deposit' ? now + amount : now - amount).toString();
}

describe('the move worked out again when the request comes in', () => {
  const TARGET = xbzz('2');
  /** A chequebook the dialog showed under the target, 0.5 xBZZ to deposit, and one over it, 1.25 to withdraw. */
  const UNDER = xbzz('1.5');
  const OVER = xbzz('3.25');

  it('is the move the dialog showed while the balance is as the page read it', () => {
    assert.deepEqual(chequebookMoveNow(TARGET, UNDER, UNDER), chequebookMove(TARGET, UNDER));
    assert.deepEqual(chequebookMoveNow(TARGET, OVER, OVER), chequebookMove(TARGET, OVER));
  });

  it('keeps the deposit shown into a chequebook its node drew on since, which lands a little under the target', () => {
    const move = chequebookMoveNow(TARGET, UNDER, xbzz('1.4'));
    assert.deepEqual(move, { direction: 'deposit', amountPlur: xbzz('0.5') });
    assert.equal(landing(xbzz('1.4'), move!), xbzz('1.9'));
  });

  it('shrinks the withdrawal from a chequebook its node drew on since, which lands on the target', () => {
    const move = chequebookMoveNow(TARGET, OVER, xbzz('3'));
    assert.deepEqual(move, { direction: 'withdraw', amountPlur: xbzz('1') });
    assert.equal(landing(xbzz('3'), move!), TARGET);
  });

  it('shrinks the deposit into a chequebook that grew since, which lands on the target', () => {
    const move = chequebookMoveNow(TARGET, UNDER, xbzz('1.8'));
    assert.deepEqual(move, { direction: 'deposit', amountPlur: xbzz('0.2') });
    assert.equal(landing(xbzz('1.8'), move!), TARGET);
  });

  it('keeps the withdrawal shown from a chequebook that grew since, which lands a little over the target', () => {
    const move = chequebookMoveNow(TARGET, OVER, xbzz('3.5'));
    assert.deepEqual(move, { direction: 'withdraw', amountPlur: xbzz('1.25') });
    assert.equal(landing(xbzz('3.5'), move!), xbzz('2.25'));
  });

  it('moves nothing for a chequebook at the target or past it now, and a PLUR short of it moves that PLUR', () => {
    for (const now of [TARGET, xbzz('2.5')]) {
      assert.equal(chequebookMoveNow(TARGET, UNDER, now), null, `a deposit, ${now} now`);
    }
    for (const now of [TARGET, xbzz('1.5'), '0']) {
      assert.equal(chequebookMoveNow(TARGET, OVER, now), null, `a withdrawal, ${now} now`);
    }
    const under = (BigInt(TARGET) - 1n).toString();
    const over = (BigInt(TARGET) + 1n).toString();
    assert.deepEqual(chequebookMoveNow(TARGET, UNDER, under), { direction: 'deposit', amountPlur: '1' });
    assert.deepEqual(chequebookMoveNow(TARGET, OVER, over), { direction: 'withdraw', amountPlur: '1' });
  });

  it('moves nothing for a chequebook the dialog showed at the target, whatever it holds now', () => {
    for (const now of [xbzz('1.5'), TARGET, xbzz('2.5')]) {
      assert.equal(chequebookMoveNow(TARGET, TARGET, now), null, `${now} now`);
    }
  });

  it('never moves more than the dialog showed, nor the other way, nor the balance read now past the target', () => {
    const balances = ['0', '1', ...['1', '1.5', '1.9999', '2', '2.0001', '3.25', '9'].map(xbzz)];
    for (const shownPlur of balances) {
      for (const nowPlur of balances) {
        const shown = chequebookMove(TARGET, shownPlur);
        const move = chequebookMoveNow(TARGET, shownPlur, nowPlur);
        const which = `${shownPlur} shown, ${nowPlur} now`;
        if (move === null) continue;
        assert.ok(shown, which);
        assert.equal(move.direction, shown.direction, which);
        assert.ok(BigInt(move.amountPlur) > 0n, which);
        assert.ok(BigInt(move.amountPlur) <= BigInt(shown.amountPlur), which);
        const landed = BigInt(landing(nowPlur, move));
        assert.ok(move.direction === 'deposit' ? landed <= BigInt(TARGET) : landed >= BigInt(TARGET), which);
      }
    }
  });

  it('keeps every PLUR, past what a floating point number holds', () => {
    assert.deepEqual(chequebookMoveNow('90071992547409931', '1', '2'), {
      direction: 'deposit',
      amountPlur: '90071992547409929',
    });
    assert.deepEqual(chequebookMoveNow(xbzz('1'), '90071992547409931', '90071992547409930'), {
      direction: 'withdraw',
      amountPlur: '80071992547409930',
    });
  });

  it('throws on what is not a whole number of PLUR, which the routes refuse first', () => {
    for (const bad of ['', '-1', '1.5', '01', '1e16', ' 1']) {
      assert.throws(() => chequebookMoveNow(bad, '0', '0'), RangeError, `target ${JSON.stringify(bad)}`);
      assert.throws(() => chequebookMoveNow('0', bad, '0'), RangeError, `shown ${JSON.stringify(bad)}`);
      assert.throws(() => chequebookMoveNow('0', '0', bad), RangeError, `now ${JSON.stringify(bad)}`);
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
