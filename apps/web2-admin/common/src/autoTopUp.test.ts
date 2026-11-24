import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTO_TOPUP_DEFAULTS,
  AUTO_TOPUP_EMAILS_MAX,
  AUTO_TOPUP_GAS_WEI_PER_TOPUP,
  AUTO_TOPUP_JOBS,
  type AutoTopUpSettings,
  FUNDING_AUTO_TOPUP_EMAILS_PATH,
  FUNDING_AUTO_TOPUP_MARKS_PATH,
  FUNDING_AUTO_TOPUP_PATH,
  FUNDING_AUTO_TOPUP_SETTINGS_PATH,
  NODE_GAS_FUND_WEI,
  autoTopUpDailyCeilingPlur,
  autoTopUpEmailProblem,
  autoTopUpEmailsProblems,
  autoTopUpMonthlyEstimatePlur,
  autoTopUpSendTiming,
  autoTopUpSettingsProblems,
  autoTopUpStampPlan,
  autoTopUpWalletPlan,
  autoTopUpWithMargin,
  autoTopUpWithinAlert,
  fundingAutoTopUpJobPath,
  storedAutoTopUpEmail,
} from './autoTopUp.js';
import type { FundingPostage } from './funding.js';
import { SECONDS_PER_DAY, stampTopUpQuote } from './stampQuote.js';

const DAY = SECONDS_PER_DAY;
const POSTAGE: FundingPostage = { pricePerChunkPerBlockPlur: '24000', blockSeconds: 5, minimumValidityBlocks: 17280 };
const DEPTH = 20;

function settings(over: Partial<AutoTopUpSettings> = {}): AutoTopUpSettings {
  return { ...AUTO_TOPUP_DEFAULTS, ...over };
}

function plan(ttlSeconds: number, over: Partial<AutoTopUpSettings> = {}) {
  return autoTopUpStampPlan({ depth: DEPTH, ttlSeconds }, settings(over), POSTAGE);
}

describe('the auto top-up routes', () => {
  it('sit under the Funding page, with a path for each job', () => {
    assert.equal(FUNDING_AUTO_TOPUP_PATH, '/api/funding/auto-top-up');
    assert.equal(FUNDING_AUTO_TOPUP_SETTINGS_PATH, '/api/funding/auto-top-up/settings');
    assert.equal(FUNDING_AUTO_TOPUP_MARKS_PATH, '/api/funding/auto-top-up/marks');
    assert.equal(FUNDING_AUTO_TOPUP_EMAILS_PATH, '/api/funding/auto-top-up/emails');
    assert.deepEqual(AUTO_TOPUP_JOBS.map(fundingAutoTopUpJobPath), [
      '/api/funding/auto-top-up/jobs/alert',
      '/api/funding/auto-top-up/jobs/wallet',
      '/api/funding/auto-top-up/jobs/stamp',
    ]);
  });
});

describe('the settings', () => {
  it('default to under 7 days, top up to 14, a day ahead, 10%, 0.1 xDAI and a ceiling that follows', () => {
    assert.deepEqual(AUTO_TOPUP_DEFAULTS, {
      topUpUnderDays: 7,
      topUpToDays: 14,
      lookAheadDays: 1,
      marginPercent: 10,
      xdaiWarningWei: '100000000000000000',
      dailyCeilingPlur: null,
    });
    assert.deepEqual(autoTopUpSettingsProblems(AUTO_TOPUP_DEFAULTS), []);
  });

  it('take whole numbers within their bounds', () => {
    assert.deepEqual(autoTopUpSettingsProblems(settings({ topUpUnderDays: 2, topUpToDays: 3, marginPercent: 0 })), []);
    for (const over of [
      { topUpUnderDays: 1 },
      { topUpUnderDays: 6.5 },
      { topUpToDays: 731 },
      { lookAheadDays: 0 },
      { marginPercent: 101 },
      { marginPercent: -1 },
    ]) {
      assert.equal(autoTopUpSettingsProblems(settings(over)).length, 1, JSON.stringify(over));
    }
  });

  it('hold the level over the threshold, and twice the look-ahead within the threshold', () => {
    assert.deepEqual(autoTopUpSettingsProblems(settings({ topUpToDays: 7 })), [
      'Top up to is more days than Top up when under.',
    ]);
    assert.deepEqual(autoTopUpSettingsProblems(settings({ lookAheadDays: 4 })), [
      'Look ahead is at most half of Top up when under.',
    ]);
    assert.deepEqual(autoTopUpSettingsProblems(settings({ lookAheadDays: 3 })), []);
  });

  it('take amounts in base units, and an empty ceiling', () => {
    assert.deepEqual(autoTopUpSettingsProblems(settings({ xdaiWarningWei: '0', dailyCeilingPlur: '0' })), []);
    for (const xdaiWarningWei of ['0.1', '', '-1', '01']) {
      assert.equal(autoTopUpSettingsProblems(settings({ xdaiWarningWei })).length, 1, JSON.stringify(xdaiWarningWei));
    }
    assert.equal(autoTopUpSettingsProblems(settings({ dailyCeilingPlur: '' })).length, 1);
  });
});

describe('the rule for one marked stamp', () => {
  it('calls it healthy above a look-ahead of the threshold, upcoming within it, and due under the threshold', () => {
    assert.equal(plan(10 * DAY).phase, 'healthy');
    assert.equal(plan(8 * DAY).phase, 'healthy');
    assert.equal(plan(8 * DAY - 1).phase, 'upcoming');
    assert.equal(plan(7 * DAY).phase, 'upcoming');
    assert.equal(plan(7 * DAY - 1).phase, 'due');
    assert.equal(plan(1).phase, 'due');
  });

  it('lists it within two look-aheads of the threshold', () => {
    assert.equal(plan(9 * DAY).listed, false);
    assert.equal(plan(9 * DAY - 1).listed, true);
    assert.equal(plan(3 * DAY).listed, true);
  });

  it('adds the whole days missing to the level for a due stamp, and the days between the two before', () => {
    assert.equal(plan(10 * DAY).days, 7);
    assert.equal(plan(7.5 * DAY).days, 7);
    assert.equal(plan(7 * DAY - 1).days, 7);
    assert.equal(plan(6.2 * DAY).days, 7);
    assert.equal(plan(6 * DAY).days, 8);
    assert.equal(plan(0.5 * DAY).days, 13);
    assert.equal(plan(5 * DAY, { topUpUnderDays: 10, topUpToDays: 40, lookAheadDays: 2 }).days, 35);
  });

  it('never takes a stamp past the level', () => {
    for (const ttl of [1, 0.5 * DAY, 3 * DAY + 17, 6 * DAY, 6.99 * DAY, 7 * DAY - 1]) {
      const { days } = plan(ttl);
      assert.ok(ttl + days * DAY <= 14 * DAY, `${ttl} + ${days} days`);
      assert.ok(ttl + (days + 1) * DAY > 14 * DAY, `${ttl} + ${days + 1} days`);
    }
  });

  it("costs what a top-up of those days costs at today's price, and that plus the margin", () => {
    const due = plan(6.2 * DAY);
    const cost = stampTopUpQuote(7, DEPTH, 6.2 * DAY, POSTAGE).costPlur;
    assert.equal(due.costPlur, cost);
    assert.equal(due.costWithMarginPlur, ((BigInt(cost) * 110n + 99n) / 100n).toString());
    assert.equal(plan(6.2 * DAY, { marginPercent: 0 }).costWithMarginPlur, cost);
  });

  it('says how long until it falls due', () => {
    assert.equal(plan(10 * DAY).dueInSeconds, 3 * DAY);
    assert.equal(plan(7 * DAY).dueInSeconds, 0);
    assert.equal(plan(2 * DAY).dueInSeconds, 0);
  });

  it('rounds the margin up to a whole PLUR', () => {
    assert.equal(autoTopUpWithMargin('100', 10), '110');
    assert.equal(autoTopUpWithMargin('101', 10), '112');
    assert.equal(autoTopUpWithMargin('1', 10), '2');
    assert.equal(autoTopUpWithMargin('0', 10), '0');
    assert.equal(autoTopUpWithMargin('7', 0), '7');
  });
});

describe('a wallet against its top-ups', () => {
  const GAS = NODE_GAS_FUND_WEI;
  const topUp = (batchId: string, ttlSeconds: number, cost: number) => ({
    batchId,
    ttlSeconds,
    costPlur: String(cost),
    costWithMarginPlur: autoTopUpWithMargin(String(cost), 10),
  });

  it('takes the stamp with the least time left first, and lacks what brings it to every cost plus the margin', () => {
    const result = autoTopUpWalletPlan({ xbzzPlur: '100', xdaiWei: GAS }, [topUp('0xa', 5, 60), topUp('0xb', 3, 50)]);
    assert.deepEqual(result.items, [
      { batchId: '0xb', covered: true, lackPlur: '0' },
      { batchId: '0xa', covered: false, lackPlur: '21' },
    ]);
    assert.equal(result.lackPlur, '21');
  });

  it('covers a later top-up the wallet holds when an earlier one is past it', () => {
    const result = autoTopUpWalletPlan({ xbzzPlur: '55', xdaiWei: GAS }, [topUp('0xx', 1, 60), topUp('0xy', 2, 50)]);
    assert.deepEqual(result.items, [
      { batchId: '0xx', covered: false, lackPlur: '11' },
      { batchId: '0xy', covered: true, lackPlur: '55' },
    ]);
    assert.equal(result.lackPlur, '66');
  });

  it('lacks nothing once it holds every cost plus the margin', () => {
    const result = autoTopUpWalletPlan({ xbzzPlur: '121', xdaiWei: GAS }, [topUp('0xa', 5, 60), topUp('0xb', 3, 50)]);
    assert.equal(result.lackPlur, '0');
    assert.deepEqual(
      result.items.map((item) => item.covered),
      [true, true],
    );
  });

  it('counts 0.001 xDAI of gas for each top-up', () => {
    assert.equal(AUTO_TOPUP_GAS_WEI_PER_TOPUP, '1000000000000000');
    const two = [topUp('0xa', 5, 10), topUp('0xb', 3, 10)];
    const short = autoTopUpWalletPlan({ xbzzPlur: '1000', xdaiWei: '1500000000000000' }, two);
    assert.equal(short.gasNeedWei, '2000000000000000');
    assert.equal(short.lacksGas, true);
    assert.deepEqual(
      short.items.map((item) => item.covered),
      [true, false],
    );
    const enough = autoTopUpWalletPlan({ xbzzPlur: '1000', xdaiWei: '2000000000000000' }, two);
    assert.equal(enough.lacksGas, false);
    assert.deepEqual(
      enough.items.map((item) => item.covered),
      [true, true],
    );
    const none = autoTopUpWalletPlan({ xbzzPlur: '1000', xdaiWei: '0' }, two);
    assert.deepEqual(
      none.items.map((item) => item.covered),
      [false, false],
    );
  });

  it('orders stamps with the same time left by their id, and answers nothing for no top-up', () => {
    const tied = autoTopUpWalletPlan({ xbzzPlur: '0', xdaiWei: GAS }, [topUp('0xb', 3, 5), topUp('0xa', 3, 5)]);
    assert.deepEqual(
      tied.items.map((item) => item.batchId),
      ['0xa', '0xb'],
    );
    assert.deepEqual(autoTopUpWalletPlan({ xbzzPlur: '5', xdaiWei: '0' }, []), {
      items: [],
      lackPlur: '0',
      gasNeedWei: '0',
      lacksGas: false,
    });
  });
});

describe('the notice rule', () => {
  const NOW = Date.UTC(2026, 10, 24, 12);
  const timing = (alertedAgoSeconds: number | null, ttlSeconds: number, over: Partial<AutoTopUpSettings> = {}) =>
    autoTopUpSendTiming(
      { alertedAt: alertedAgoSeconds === null ? null : NOW - alertedAgoSeconds * 1000, ttlSeconds },
      settings(over),
      NOW,
    );

  it('lets a send go once its alert is a look-ahead old', () => {
    assert.equal(timing(DAY, 6.9 * DAY), 'go');
    assert.equal(timing(DAY - 60, 6.9 * DAY), 'wait');
    assert.equal(timing(3 * DAY, 6 * DAY, { lookAheadDays: 3 }), 'go');
    assert.equal(timing(2 * DAY, 6.5 * DAY, { lookAheadDays: 3 }), 'wait');
  });

  it('waits with no alert given, down to the floor of two look-aheads', () => {
    assert.equal(timing(null, 6.9 * DAY), 'wait');
    assert.equal(timing(null, 2 * DAY), 'wait');
    assert.equal(timing(null, 2 * DAY - 1), 'floor');
    assert.equal(timing(600, 1 * DAY), 'floor');
    assert.equal(timing(2 * DAY, 5.9 * DAY, { lookAheadDays: 3 }), 'floor');
  });

  it('calls a send under the floor whose alert is old enough an ordinary one', () => {
    assert.equal(timing(DAY, 1 * DAY), 'go');
  });
});

describe('the amount rule', () => {
  it('keeps a send within what its alert said', () => {
    assert.equal(autoTopUpWithinAlert('5', '5'), true);
    assert.equal(autoTopUpWithinAlert('0', '0'), true);
    assert.equal(autoTopUpWithinAlert('6', '5'), false);
    assert.equal(autoTopUpWithinAlert('1', '0'), false);
    assert.equal(autoTopUpWithinAlert('0', null), false);
  });
});

describe('the monthly estimate and the daily ceiling', () => {
  it("sums 30 days of top-ups for each stamp's depth, with no margin", () => {
    const one = (depth: number) => BigInt(stampTopUpQuote(30, depth, 0, POSTAGE).costPlur);
    assert.equal(autoTopUpMonthlyEstimatePlur([20, 22, 20], POSTAGE), (one(20) * 2n + one(22)).toString());
    assert.equal(autoTopUpMonthlyEstimatePlur([], POSTAGE), '0');
  });

  it('caps a day at half the monthly estimate until a ceiling is saved', () => {
    assert.equal(autoTopUpDailyCeilingPlur(settings(), '1001'), '500');
    assert.equal(autoTopUpDailyCeilingPlur(settings({ dailyCeilingPlur: '42' }), '1001'), '42');
    assert.equal(autoTopUpDailyCeilingPlur(settings({ dailyCeilingPlur: '0' }), '1001'), '0');
  });
});

describe('the email list', () => {
  it('keeps an address trimmed and in lower case', () => {
    assert.equal(storedAutoTopUpEmail('  Ops@Example.ORG '), 'ops@example.org');
  });

  it('takes an address with a name, an at sign and a domain', () => {
    for (const email of ['ops@example.org', 'first.last+tag@mail.example.org', ' Ops@Example.org ']) {
      assert.equal(autoTopUpEmailProblem(email), null, email);
    }
    for (const email of ['', '   ', 'ops', 'ops@example', 'o ps@example.org', 'a@b@example.org', 'ops@example.org.']) {
      assert.notEqual(autoTopUpEmailProblem(email), null, JSON.stringify(email));
    }
    assert.notEqual(autoTopUpEmailProblem(`${'a'.repeat(250)}@example.org`), null);
  });

  it('takes each address once, and 20 at most', () => {
    assert.deepEqual(autoTopUpEmailsProblems(['ops@example.org', 'dev@example.org']), []);
    assert.deepEqual(autoTopUpEmailsProblems([]), []);
    assert.deepEqual(autoTopUpEmailsProblems(['ops@example.org', ' OPS@example.org']), [
      'ops@example.org is on the list twice.',
    ]);
    assert.deepEqual(autoTopUpEmailsProblems(['ops']), ['ops: Enter an email address such as name@example.org.']);
    const many = Array.from({ length: AUTO_TOPUP_EMAILS_MAX + 1 }, (_unused, index) => `ops${index}@example.org`);
    assert.deepEqual(autoTopUpEmailsProblems(many), ['The list holds at most 20 addresses.']);
  });
});
