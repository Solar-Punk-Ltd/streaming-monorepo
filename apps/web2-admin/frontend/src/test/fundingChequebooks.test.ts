import { describe, expect, it } from 'vitest';
import type { AdminFundingNode, FundingView } from '@streaming-monorepo/web2-admin-common';

import {
  allChequebookNodes,
  availableAfter,
  CHEQUEBOOK_UNREAD_TEXT,
  checkChequebooks,
  chequebookCount,
  chequebookGroups,
  depositCount,
  GATEWAY_TEXT,
  MINUS,
  moveText,
  NO_BREAK,
  NOTHING_TICKED_PROBLEM,
  NOTHING_TO_CHANGE_PROBLEM,
  readTarget,
  reportsChequebooks,
  TARGET_EMPTY_PROBLEM,
  TARGET_FLOOR_TEXT,
  TARGET_TOO_LARGE_PROBLEM,
  TARGET_UNDER_FLOOR_PROBLEM,
  WALLET_UNREAD_TEXT,
  whyNotMovable,
  withdrawalCount,
} from '../components/funding/chequebooks';
import {
  makeChequebook,
  makeChequebookView,
  makeNode,
  makeView,
  OVER_TARGET,
  unreadChequebook,
  xbzz,
} from './fundingFixtures';

/** The main stage's uploader under the target of 2 xBZZ, its rung over it, and its rung at it. */
const UNDER = 'stage-1:bee';
const OVER = 'stage-1:720p';
const AT = 'stage-1:1080p';

/** Every node holds 5 xBZZ. */
const FIVE_XBZZ = 50_000_000_000_000_000n;

const select = (target: string, ticked: string[]) => ({ target, ticked: new Set(ticked) });

/** The view with one main-stage node changed, by its id. */
function withNode(nodeId: string, over: Partial<AdminFundingNode>, view: FundingView = makeChequebookView()) {
  for (const stage of view.stages) {
    stage.nodes = stage.nodes.map((node) => (node.nodeId === nodeId ? { ...node, ...over } : node));
  }
  return view;
}

describe('the chequebooks, grouped', () => {
  it("lists each stage's nodes that have a chequebook under its name, with no catalogue group", () => {
    const groups = chequebookGroups(makeChequebookView());
    expect(groups.map((group) => [group.title, group.nodes.catalogue, group.rows.map((node) => node.label)])).toEqual([
      ['Main stage', false, ['stage-1-uploader', 'rung-720p', 'rung-1080p', 'rung-480p', 'stage-1-gateway']],
      ['Second stage', false, ['pool-360p']],
      ['Third stage', false, []],
    ]);
  });

  it('knows whether the manager reports chequebooks at all, which one older than the tab does not', () => {
    expect(reportsChequebooks(makeView())).toBe(false);
    expect(chequebookGroups(makeView()).map((group) => group.rows.length)).toEqual([0, 0]);
    expect(reportsChequebooks(makeChequebookView())).toBe(true);

    // A manager that reads chequebooks and finds none still reports them; the catalogue node's alone does not count.
    const none = makeView();
    for (const stage of none.stages) stage.nodes = stage.nodes.map((node) => ({ ...node, chequebook: null }));
    expect(reportsChequebooks(none)).toBe(true);
    const catalogueOnly = makeView();
    if (catalogueOnly.catalogue) catalogueOnly.catalogue = { ...catalogueOnly.catalogue, chequebook: makeChequebook() };
    expect(reportsChequebooks(catalogueOnly)).toBe(false);
  });

  it('lists a node two stages share under both, and counts it once, for the first listing that can be moved', () => {
    const pool = { nodeId: 'pool:720p', role: 'rung' } as const;
    const view = makeChequebookView();
    // The main stage's listing could not be read about the chequebook; the second stage's could.
    view.stages[0]?.nodes.push(makeNode({ ...pool, label: 'main-720p', chequebook: unreadChequebook() }));
    view.stages[1]?.nodes.push(makeNode({ ...pool, label: 'second-720p', chequebook: makeChequebook() }));

    expect(
      chequebookGroups(view).filter((group) => group.rows.some((node) => node.nodeId === 'pool:720p')),
    ).toHaveLength(2);
    const listed = allChequebookNodes(view);
    expect(listed.filter((node) => node.nodeId === 'pool:720p').map((node) => node.label)).toEqual(['second-720p']);
    // Still in the place it is first listed.
    expect(listed.map((node) => node.nodeId)).toEqual([
      UNDER,
      OVER,
      AT,
      'stage-1:480p',
      'stage-1:gateway',
      'pool:720p',
      'stage-2:360p',
    ]);
  });
});

describe('which chequebooks can be ticked', () => {
  it("ticks a stage's own Bee node's and a rung's, with the wallet and the chequebook read", () => {
    expect(whyNotMovable(makeNode({ chequebook: makeChequebook() }))).toBeNull();
    expect(whyNotMovable(makeNode({ role: 'rung', chequebook: makeChequebook() }))).toBeNull();
  });

  it("shows a gateway's read-only, and says why it cannot tick one not read or whose wallet was not read", () => {
    expect(whyNotMovable(makeNode({ role: 'gateway', chequebook: makeChequebook() }))).toBe(GATEWAY_TEXT);
    expect(whyNotMovable(makeNode({ role: 'gateway', chequebook: unreadChequebook() }))).toBe(GATEWAY_TEXT);
    expect(whyNotMovable(makeNode({ chequebook: unreadChequebook() }))).toBe(CHEQUEBOOK_UNREAD_TEXT);
    expect(whyNotMovable(makeNode({ chequebook: makeChequebook({ readError: '' }) }))).toBe(CHEQUEBOOK_UNREAD_TEXT);
    const unreadWallet = { walletAddress: null, xdaiWei: null, xbzzPlur: null, readError: 'The node did not answer.' };
    expect(whyNotMovable(makeNode({ ...unreadWallet, chequebook: makeChequebook() }))).toBe(WALLET_UNREAD_TEXT);
  });
});

describe('the target', () => {
  it('is an amount of xBZZ of at least 1, every digit of it', () => {
    expect(TARGET_FLOOR_TEXT).toBe('At least 1 xBZZ');
    expect(readTarget('')).toEqual({ kind: 'empty' });
    expect(readTarget('2')).toEqual({ kind: 'ok', plur: xbzz('2') });
    expect(readTarget('1')).toEqual({ kind: 'ok', plur: xbzz('1') });
    expect(readTarget('1.0000000000000001')).toEqual({ kind: 'ok', plur: '10000000000000001' });
    expect(readTarget('12.')).toEqual({ kind: 'ok', plur: xbzz('12') });
  });

  it('refuses a target under 1 xBZZ, and one it cannot read, saying why', () => {
    for (const typed of ['0', '0.9999999999999999', '.5']) {
      expect(readTarget(typed), typed).toEqual({ kind: 'invalid', problem: TARGET_UNDER_FLOOR_PROBLEM });
    }
    expect(TARGET_UNDER_FLOOR_PROBLEM).toBe('The target is at least 1 xBZZ.');
    expect(readTarget('.')).toEqual({ kind: 'invalid', problem: 'The target: Digits and one dot only, such as 1.5.' });
    expect(readTarget('1.00000000000000001')).toEqual({ kind: 'invalid', problem: 'The target: At most 16 decimals.' });
  });

  it('takes a target of 30 digits of PLUR, the most the API takes, and refuses one more, saying so', () => {
    expect(readTarget(`${'9'.repeat(14)}.${'9'.repeat(16)}`)).toEqual({ kind: 'ok', plur: '9'.repeat(30) });
    expect(TARGET_TOO_LARGE_PROBLEM).toBe('The target: That is more than any chequebook holds.');
    // 31 digits of PLUR, and past the 78 any amount field reads, alike.
    for (const typed of [`1${'0'.repeat(14)}`, `${'9'.repeat(15)}.5`, `1${'0'.repeat(70)}`]) {
      expect(readTarget(typed), typed).toEqual({ kind: 'invalid', problem: TARGET_TOO_LARGE_PROBLEM });
    }
  });

  it('holds Apply for a target over 30 digits of PLUR, with no move shown', () => {
    const check = checkChequebooks(makeChequebookView(), select(`1${'0'.repeat(14)}`, [UNDER]));
    expect(check.problems).toEqual([TARGET_TOO_LARGE_PROBLEM]);
    expect(check.lines).toEqual([]);
    expect(check.request).toBeNull();
  });
});

describe('what bringing the ticked chequebooks to the target comes to', () => {
  it('asks for nothing with no target and nothing ticked, and says both', () => {
    const check = checkChequebooks(makeChequebookView(), select('', []));
    expect(check.problems).toEqual([TARGET_EMPTY_PROBLEM, NOTHING_TICKED_PROBLEM]);
    expect(check.lines).toEqual([]);
    expect(check.request).toBeNull();
    expect(check.deposits).toEqual({ count: 0, totalPlur: '0' });
    expect(check.withdrawals).toEqual({ count: 0, totalPlur: '0' });
  });

  it('deposits the difference into one under the target, withdraws it from one over, and leaves one at it', () => {
    const check = checkChequebooks(makeChequebookView(), select('2', [UNDER, OVER, AT]));
    expect(check.problems).toEqual([]);
    expect(check.tickedCount).toBe(3);
    expect(check.lines.map((line) => [line.node.nodeId, line.availablePlur, line.move])).toEqual([
      [UNDER, xbzz('1.5'), { direction: 'deposit', amountPlur: xbzz('0.5') }],
      [OVER, xbzz(OVER_TARGET), { direction: 'withdraw', amountPlur: '12500000000000001' }],
      [AT, xbzz('2'), null],
    ]);
    // What each node's wallet holds after: a deposit is paid from it, a withdrawal lands in it.
    expect(check.ledgerOf.get(UNDER)).toEqual({
      afterPlur: (FIVE_XBZZ - 5_000_000_000_000_000n).toString(),
      shortPlur: null,
      fundPlur: null,
      noGas: false,
    });
    expect(check.ledgerOf.get(OVER)?.afterPlur).toBe('62500000000000001');
    expect(check.ledgerOf.has(AT)).toBe(false);
    expect(check.deposits).toEqual({ count: 1, totalPlur: xbzz('0.5') });
    expect(check.withdrawals).toEqual({ count: 1, totalPlur: '12500000000000001' });
    // The one at the target is not asked for, and each item names the balance the page shows.
    expect(check.request).toEqual({
      targetPlur: xbzz('2'),
      items: [
        { nodeId: UNDER, availablePlur: xbzz('1.5') },
        { nodeId: OVER, availablePlur: xbzz(OVER_TARGET) },
      ],
    });
  });

  it('shows no move while the target is under 1 xBZZ or cannot be read', () => {
    for (const [typed, problem] of [
      ['0.5', TARGET_UNDER_FLOOR_PROBLEM],
      ['.', 'The target: Digits and one dot only, such as 1.5.'],
    ] as const) {
      const check = checkChequebooks(makeChequebookView(), select(typed, [UNDER]));
      expect(check.problems, typed).toEqual([problem]);
      expect(check.lines, typed).toEqual([]);
      expect(check.tickedCount, typed).toBe(1);
      expect(check.request, typed).toBeNull();
    }
  });

  it('has nothing to change while every ticked chequebook is at the target', () => {
    const check = checkChequebooks(makeChequebookView(), select('2', [AT]));
    expect(check.problems).toEqual([NOTHING_TO_CHANGE_PROBLEM]);
    expect(check.lines.map((line) => line.move)).toEqual([null]);
    expect(check.request).toBeNull();
  });

  it('says what a node lacks for its deposit, exactly and rounded up to three decimals', () => {
    const check = checkChequebooks(makeChequebookView(), select('7.0004', [UNDER]));
    expect(check.lines[0]?.move).toEqual({ direction: 'deposit', amountPlur: xbzz('5.5004') });
    expect(check.ledgerOf.get(UNDER)).toEqual({
      afterPlur: null,
      shortPlur: xbzz('0.5004'),
      fundPlur: xbzz('0.501'),
      noGas: false,
    });
    expect(check.problems).toEqual(['stage-1-uploader is short of 0.501 xBZZ for its deposit.']);
    // The request is what Apply would send; the problem keeps Apply from sending it.
    expect(check.request).not.toBeNull();
  });

  it("takes the whole of a node's xBZZ for its deposit, and a withdrawal of any size into it", () => {
    const all = checkChequebooks(makeChequebookView(), select('6.5', [UNDER, OVER]));
    expect(all.ledgerOf.get(UNDER)).toMatchObject({ afterPlur: '0', shortPlur: null });
    expect(all.problems).toEqual([]);

    const poor = withNode(OVER, { xbzzPlur: '0' });
    expect(checkChequebooks(poor, select('1', [OVER])).ledgerOf.get(OVER)).toMatchObject({
      afterPlur: '22500000000000001',
      shortPlur: null,
    });
  });

  it('needs xDAI for the gas of a deposit and of a withdrawal, but none for a chequebook at the target', () => {
    let view = makeChequebookView();
    for (const nodeId of [UNDER, OVER, AT]) view = withNode(nodeId, { xdaiWei: '0' }, view);
    const check = checkChequebooks(view, select('2', [UNDER, OVER, AT]));
    expect(check.problems).toEqual([
      'stage-1-uploader holds no xDAI to pay the gas.',
      'rung-720p holds no xDAI to pay the gas.',
    ]);
    expect(check.ledgerOf.get(UNDER)).toMatchObject({ noGas: true, afterPlur: xbzz('4.5') });
  });

  it('asks for a node two stages share once', () => {
    const shared = makeNode({ nodeId: 'pool:720p', label: 'shared-720p', role: 'rung', chequebook: makeChequebook() });
    const view = makeChequebookView();
    view.stages[0]?.nodes.push(shared);
    view.stages[1]?.nodes.push(shared);
    const check = checkChequebooks(view, select('2', ['pool:720p']));
    expect(check.lines).toHaveLength(1);
    expect(check.request).toEqual({
      targetPlur: xbzz('2'),
      items: [{ nodeId: 'pool:720p', availablePlur: xbzz('1.5') }],
    });
    expect(check.deposits).toEqual({ count: 1, totalPlur: xbzz('0.5') });
  });

  it('never counts a tick left on a chequebook that cannot be moved, nor on a node with none', () => {
    const check = checkChequebooks(
      makeChequebookView(),
      select('2', ['stage-1:gateway', 'stage-1:480p', 'stage-2:360p', 'stage-1:240p', 'catalogue:bee']),
    );
    expect(check.tickedCount).toBe(0);
    expect(check.lines).toEqual([]);
    expect(check.problems).toEqual([NOTHING_TICKED_PROBLEM]);
  });
});

describe('a move, as the page says it', () => {
  it('names its direction and every digit of its amount, which never breaks from its token', () => {
    expect(moveText({ direction: 'deposit', amountPlur: xbzz('0.5') })).toBe(`deposit +0.5${NO_BREAK}xBZZ`);
    expect(moveText({ direction: 'withdraw', amountPlur: '12500000000000001' })).toBe(
      `withdraw ${MINUS}1.2500000000000001${NO_BREAK}xBZZ`,
    );
    expect(moveText(null)).toBe('no change');
    // The minus sign and the space that does not break, not a hyphen and a plain space.
    expect([MINUS.codePointAt(0), NO_BREAK.codePointAt(0)]).toEqual([0x2212, 0xa0]);
  });

  it("leaves the chequebook's available balance at the target", () => {
    const check = checkChequebooks(makeChequebookView(), select('2', [UNDER, OVER, AT]));
    expect(check.lines.map(availableAfter)).toEqual([xbzz('2'), xbzz('2'), xbzz('2')]);
  });

  it('counts chequebooks, deposits and withdrawals', () => {
    expect([chequebookCount(1), chequebookCount(2), depositCount(1), depositCount(0)]).toEqual([
      '1 chequebook',
      '2 chequebooks',
      '1 deposit',
      '0 deposits',
    ]);
    expect([withdrawalCount(1), withdrawalCount(3)]).toEqual(['1 withdrawal', '3 withdrawals']);
  });
});
