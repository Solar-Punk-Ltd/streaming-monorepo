import type { AdminFundingNode, FundingTransferItem, FundingView } from '@streaming-monorepo/web2-admin-common';

/** The brand wallet: the address of private key 1, which nobody signs with. */
export const WALLET = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';

/** A stage's uploader node with a confirmed address, 0.2 xDAI and 5 xBZZ. */
export function makeNode(over: Partial<AdminFundingNode> = {}): AdminFundingNode {
  return {
    nodeId: 'stage-1:bee',
    label: 'stage-1-uploader',
    role: 'uploader',
    walletAddress: '0x1111111111111111111111111111111111111111',
    xdaiWei: '200000000000000000',
    xbzzPlur: '50000000000000000',
    readError: null,
    pin: 'pinned',
    pinnedAddress: '0x1111111111111111111111111111111111111111',
    ...over,
  };
}

/**
 * A configured Funding page: a wallet with 1.5 xDAI and 12.5 xBZZ, the catalogue node, a stage with a confirmed node
 * and a stage whose one rung has a new address, and no send still open.
 */
export function makeView(over: Partial<FundingView> = {}): FundingView {
  return {
    configured: true,
    wallet: { address: WALLET, xdaiWei: '1500000000000000000', xbzzPlur: '125000000000000000' },
    chainId: 100,
    stages: [
      { stageId: 'stage-1', name: 'Main stage', nodes: [makeNode()] },
      {
        stageId: 'stage-2',
        name: 'Second stage',
        nodes: [
          makeNode({
            nodeId: 'stage-2:360p',
            label: 'pool-360p',
            role: 'rung',
            walletAddress: '0x2222222222222222222222222222222222222222',
            pin: 'new',
            pinnedAddress: null,
          }),
        ],
      },
    ],
    catalogue: makeNode({
      nodeId: 'catalogue:bee',
      label: 'catalogue-node',
      walletAddress: '0x1234567890123456789012345678901234567890',
      pinnedAddress: '0x1234567890123456789012345678901234567890',
    }),
    postage: null,
    observedAt: '2026-10-05T10:00:00.000Z',
    managerError: null,
    openBulkId: null,
    openStampBulkId: null,
    ...over,
  };
}

/**
 * One transfer of a send: 0.1 xDAI to the stage's uploader, sent and not in a block yet, so it holds up a new send
 * (`settled` false) and is under way rather than watched (`watched` false), as the API answers it.
 */
export function makeItem(over: Partial<FundingTransferItem> = {}): FundingTransferItem {
  return {
    requestId: 'request-1',
    nodeId: 'stage-1:bee',
    kind: 'xdai',
    amount: '100000000000000000',
    state: 'submitted',
    txHash: null,
    blockNumber: null,
    error: null,
    settled: false,
    watched: false,
    ...over,
  };
}

/** A ticked node with the amounts typed for it. */
export const draft = (xdai = '', xbzz = '') => ({ ticked: true, xdai, xbzz });
