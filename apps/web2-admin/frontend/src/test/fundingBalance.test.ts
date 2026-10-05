import { describe, expect, it } from 'vitest';

import { checkSend, nodeGroups, txUrl, unconfirmedNodes, EXPLORER_TX_URL } from '../components/funding/balance';
import { draft, makeNode, makeView, WALLET } from './fundingFixtures';

describe('the nodes, grouped', () => {
  it('puts the catalogue node in a group of its own on top, then each stage in the order the admin answers', () => {
    const groups = nodeGroups(makeView());
    expect(groups.map((g) => [g.title, g.catalogue, g.nodes.map((n) => n.label)])).toEqual([
      ['Catalogue node', true, ['catalogue-node']],
      ['Main stage', false, ['stage-1-uploader']],
      ['Second stage', false, ['pool-360p']],
    ]);
  });

  it('has no catalogue group when no node is designated, and keeps a stage that reports no node', () => {
    const groups = nodeGroups(
      makeView({ catalogue: null, stages: [{ stageId: 'stage-3', name: 'Empty', nodes: [] }] }),
    );
    expect(groups.map((g) => [g.title, g.nodes.length])).toEqual([['Empty', 0]]);
  });

  it('asks to confirm the new and changed addresses, and none it cannot read', () => {
    const view = makeView();
    view.stages[0]?.nodes.push(
      makeNode({
        nodeId: 'stage-1:changed',
        label: 'moved',
        walletAddress: '0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09',
        pin: 'changed',
        pinnedAddress: '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3',
      }),
      makeNode({ nodeId: 'stage-1:unread', label: 'unread', walletAddress: null, pin: 'new', pinnedAddress: null }),
    );
    expect(unconfirmedNodes(view).map((n) => n.label)).toEqual(['moved', 'pool-360p']);
  });
});

describe('a node shared by two stages', () => {
  const shared = makeNode({
    nodeId: 'pool:720p',
    label: 'shared-720p',
    role: 'rung',
    walletAddress: '0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09',
    pin: 'new',
    pinnedAddress: null,
  });
  const withShared = (node: typeof shared) => {
    const view = makeView();
    view.stages[0]?.nodes.push(node);
    view.stages[1]?.nodes.push(node);
    return view;
  };

  it('is listed under both stages, and asked to confirm once', () => {
    const view = withShared(shared);
    expect(
      nodeGroups(view)
        .filter((group) => group.nodes.includes(shared))
        .map((group) => group.title),
    ).toEqual(['Main stage', 'Second stage']);
    expect(unconfirmedNodes(view).map((node) => node.nodeId)).toEqual(['pool:720p', 'stage-2:360p']);
  });

  it('is counted and sent once', () => {
    const pinned = { ...shared, pin: 'pinned' as const, pinnedAddress: shared.walletAddress };
    const check = checkSend(withShared(pinned), { 'pool:720p': draft('0.5', '1') });
    expect(check.lines).toEqual([
      { nodeId: 'pool:720p', label: 'shared-720p', kind: 'xdai', amount: '500000000000000000' },
      { nodeId: 'pool:720p', label: 'shared-720p', kind: 'xbzz', amount: '10000000000000000' },
    ]);
    expect(check.totals).toEqual({ xdai: '500000000000000000', xbzz: '10000000000000000' });
  });
});

describe('what Send would send, and why it cannot', () => {
  it('cannot send with nothing ticked', () => {
    const check = checkSend(makeView(), {});
    expect(check.lines).toEqual([]);
    expect(check.problems).toEqual(['Tick a node and enter an amount to send.']);
  });

  it('sends each amount entered on a ticked node, in base units, and adds them up exactly', () => {
    const check = checkSend(makeView(), {
      'stage-1:bee': draft('0.1', '2.5'),
      'catalogue:bee': draft('0.2', ''),
      'stage-2:360p': { ticked: false, xdai: '9', xbzz: '9' },
    });
    expect(check.problems).toEqual([]);
    expect(check.lines).toEqual([
      { nodeId: 'catalogue:bee', label: 'catalogue-node', kind: 'xdai', amount: '200000000000000000' },
      { nodeId: 'stage-1:bee', label: 'stage-1-uploader', kind: 'xdai', amount: '100000000000000000' },
      { nodeId: 'stage-1:bee', label: 'stage-1-uploader', kind: 'xbzz', amount: '25000000000000000' },
    ]);
    expect(check.totals).toEqual({ xdai: '300000000000000000', xbzz: '25000000000000000' });
    expect(check.over).toEqual({ xdai: false, xbzz: false });
  });

  it('skips a zero and an empty amount, and cannot send when that leaves nothing', () => {
    const check = checkSend(makeView(), { 'stage-1:bee': draft('0', '') });
    expect(check.lines).toEqual([]);
    expect(check.problems).toEqual(['Tick a node and enter an amount to send.']);
  });

  it('takes the whole balance, and nothing over it', () => {
    const all = checkSend(makeView(), { 'stage-1:bee': draft('1.5', '12.5') });
    expect(all.over).toEqual({ xdai: false, xbzz: false });
    expect(all.problems).toEqual([]);

    const over = checkSend(makeView(), {
      'stage-1:bee': draft('1', '12.5'),
      'catalogue:bee': draft('0.500000000000000001', '0.0000000000000001'),
    });
    expect(over.over).toEqual({ xdai: true, xbzz: true });
    expect(over.problems).toEqual([
      'That is more xDAI than the brand wallet holds.',
      'That is more xBZZ than the brand wallet holds.',
    ]);
  });

  it('cannot send to a node whose address is not confirmed', () => {
    const check = checkSend(makeView(), { 'stage-2:360p': draft('0.1', '') });
    expect(check.problems).toEqual(['Confirm the address of pool-360p before sending to it.']);
  });

  it('cannot send an amount it cannot read, and names the node', () => {
    const check = checkSend(makeView(), { 'stage-1:bee': draft('1,5', '') });
    expect(check.problems).toEqual(['The xDAI amount for stage-1-uploader: Digits and one dot only, such as 1.5.']);
  });

  it('cannot send without a brand wallet, or while its balance is not known', () => {
    expect(checkSend(makeView({ wallet: null }), { 'stage-1:bee': draft('0.1') }).problems).toEqual([
      'There is no brand wallet to send from.',
    ]);
    const unread = makeView({ wallet: { address: WALLET, xdaiWei: null, xbzzPlur: '1' } });
    expect(checkSend(unread, { 'stage-1:bee': draft('0.1') }).problems).toEqual([
      "The brand wallet's xDAI balance could not be read.",
    ]);
  });
});

describe('a transfer on the block explorer', () => {
  it('links its hash under the one explorer address', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    expect(txUrl(hash)).toBe(`${EXPLORER_TX_URL}${hash}`);
  });
});
