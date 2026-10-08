import {
  parseBaseUnits,
  XBZZ_DECIMALS,
  type AdminFundingNode,
  type FundingBatch,
  type FundingChequebook,
  type FundingChequebookItem,
  type FundingPostage,
  type FundingStampItem,
  type FundingTransferItem,
  type FundingView,
} from '@streaming-monorepo/web2-admin-common';

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
    openChequebookBulkId: null,
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

export const DAY = 86_400;

/**
 * Gnosis Chain's block time and postage floor, at 24000 PLUR per chunk per block: 30 days are 518400 blocks, which
 * cost a batch of depth 20 1.30459631616 xBZZ, and one of depth 22 four times that, 5.21838526464 xBZZ.
 */
export const POSTAGE: FundingPostage = {
  pricePerChunkPerBlockPlur: '24000',
  blockSeconds: 5,
  minimumValidityBlocks: 17280,
};

/** What 30 days cost a batch of depth 20 at {@link POSTAGE}, in PLUR. */
export const THIRTY_DAYS_DEPTH_20 = '13045963161600000';

/** One batch id per batch of {@link makeStampView}. */
export const BATCH = {
  catalogue: `0x${'aa'.repeat(32)}`,
  stage: `0x${'bb'.repeat(32)}`,
  rung: `0x${'cc'.repeat(32)}`,
  expired: `0x${'dd'.repeat(32)}`,
  unread: `0x${'ee'.repeat(32)}`,
} as const;

/** A usable, mutable batch of depth 20 with 40 days left and a quarter full: the catalogue's. */
export function makeBatch(over: Partial<FundingBatch> = {}): FundingBatch {
  return {
    batchId: BATCH.catalogue,
    depth: 20,
    immutable: false,
    usable: true,
    ttlSeconds: 40 * DAY,
    fillRatio: 0.25,
    readError: null,
    ...over,
  };
}

/** A batch its node could not be read about: every reading null, and why. */
export function unreadBatch(batchId: string = BATCH.unread): FundingBatch {
  return {
    batchId,
    depth: null,
    immutable: null,
    usable: null,
    ttlSeconds: null,
    fillRatio: null,
    readError: 'The node did not answer in time.',
  };
}

/**
 * The Funding page with batches and today's price ({@link POSTAGE}), every node holding 0.2 xDAI and 5 xBZZ:
 * - the catalogue node's batch, depth 20 with 40 days left;
 * - on the main stage, the uploader's immutable batch, depth 22 with 12 days left, whose 30 days cost more than the
 *   node holds; a rung's expired batch; a rung whose batch was not read; and a gateway, which has none;
 * - on the second stage, a rung's batch of depth 20 with 10 days left, which no dilution leaves 7 days.
 */
export function makeStampView(over: Partial<FundingView> = {}): FundingView {
  const base = makeView();
  return {
    ...base,
    postage: POSTAGE,
    catalogue: base.catalogue && { ...base.catalogue, batch: makeBatch() },
    stages: [
      {
        stageId: 'stage-1',
        name: 'Main stage',
        nodes: [
          makeNode({
            batch: makeBatch({
              batchId: BATCH.stage,
              depth: 22,
              immutable: true,
              ttlSeconds: 12 * DAY,
              fillRatio: 0.5,
            }),
          }),
          makeNode({
            nodeId: 'stage-1:720p',
            label: 'rung-720p',
            role: 'rung',
            batch: makeBatch({ batchId: BATCH.expired, usable: false, ttlSeconds: 0, fillRatio: 0.9 }),
          }),
          makeNode({ nodeId: 'stage-1:1080p', label: 'rung-1080p', role: 'rung', batch: unreadBatch() }),
          makeNode({ nodeId: 'stage-1:gateway', label: 'stage-1-gateway', role: 'gateway', batch: null }),
        ],
      },
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
            batch: makeBatch({ batchId: BATCH.rung, ttlSeconds: 10 * DAY, fillRatio: 0.7 }),
          }),
        ],
      },
    ],
    ...over,
  };
}

/**
 * One top-up of a stamp bulk: 30 days on the catalogue batch, sent and not yet confirmed, so it holds up a new stamp
 * bulk (`settled` false) and is under way rather than watched (`watched` false), as the API answers it.
 */
export function makeStampItem(over: Partial<FundingStampItem> = {}): FundingStampItem {
  return {
    requestId: 'stamp-request-1',
    kind: 'topup',
    nodeId: 'catalogue:bee',
    nodeLabel: 'catalogue-node',
    batchId: BATCH.catalogue,
    days: 30,
    steps: null,
    costPlur: THIRTY_DAYS_DEPTH_20,
    state: 'submitted',
    txHash: null,
    error: null,
    settled: false,
    watched: false,
    ...over,
  };
}

/** An amount of xBZZ in PLUR, every digit of it: `xbzz('1.5')` is 15000000000000000. */
export function xbzz(amount: string): string {
  const plur = parseBaseUnits(amount, XBZZ_DECIMALS);
  if (plur === null) throw new Error(`${amount} is not an amount of xBZZ`);
  return plur;
}

/** A chequebook its node read: 1.5 xBZZ available of 2 in all, so 0.5 xBZZ in cheques its peers have not cashed. */
export function makeChequebook(over: Partial<FundingChequebook> = {}): FundingChequebook {
  return {
    address: '0x3333333333333333333333333333333333333333',
    availablePlur: xbzz('1.5'),
    totalPlur: xbzz('2'),
    readError: null,
    ...over,
  };
}

/** A chequebook its node could not be read about: every reading null, and why. */
export function unreadChequebook(readError = 'The node did not answer in time.'): FundingChequebook {
  return { address: null, availablePlur: null, totalPlur: null, readError };
}

/** The available balance of the main stage's rung over the target of 2 xBZZ, in xBZZ: every digit counts. */
export const OVER_TARGET = '3.2500000000000001';

/**
 * The Funding page with chequebooks, every node holding 0.2 xDAI and 5 xBZZ:
 * - the catalogue node's chequebook, which the Chequebooks tab does not list;
 * - on the main stage, the uploader's 1.5 xBZZ available of 2, under a target of 2 xBZZ; a rung's {@link OVER_TARGET},
 *   over it; a rung's 2 xBZZ of 2.5, at it; a rung whose chequebook was not read; a gateway's 1 xBZZ, which the tab
 *   shows read-only; and a rung that has no chequebook;
 * - on the second stage, a rung whose wallet was not read, with its chequebook of 1 xBZZ;
 * - on a third stage, an uploader that has no chequebook.
 */
export function makeChequebookView(over: Partial<FundingView> = {}): FundingView {
  const base = makeView();
  return {
    ...base,
    catalogue: base.catalogue && { ...base.catalogue, chequebook: makeChequebook() },
    stages: [
      {
        stageId: 'stage-1',
        name: 'Main stage',
        nodes: [
          makeNode({ chequebook: makeChequebook() }),
          makeNode({
            nodeId: 'stage-1:720p',
            label: 'rung-720p',
            role: 'rung',
            chequebook: makeChequebook({ availablePlur: xbzz(OVER_TARGET), totalPlur: xbzz(OVER_TARGET) }),
          }),
          makeNode({
            nodeId: 'stage-1:1080p',
            label: 'rung-1080p',
            role: 'rung',
            chequebook: makeChequebook({ availablePlur: xbzz('2'), totalPlur: xbzz('2.5') }),
          }),
          makeNode({ nodeId: 'stage-1:480p', label: 'rung-480p', role: 'rung', chequebook: unreadChequebook() }),
          makeNode({
            nodeId: 'stage-1:gateway',
            label: 'stage-1-gateway',
            role: 'gateway',
            chequebook: makeChequebook({ availablePlur: xbzz('1'), totalPlur: xbzz('1') }),
          }),
          makeNode({ nodeId: 'stage-1:240p', label: 'rung-240p', role: 'rung', chequebook: null }),
        ],
      },
      {
        stageId: 'stage-2',
        name: 'Second stage',
        nodes: [
          makeNode({
            nodeId: 'stage-2:360p',
            label: 'pool-360p',
            role: 'rung',
            walletAddress: null,
            xdaiWei: null,
            xbzzPlur: null,
            readError: 'The node did not answer.',
            pin: 'new',
            pinnedAddress: null,
            chequebook: makeChequebook({ availablePlur: xbzz('1'), totalPlur: xbzz('1') }),
          }),
        ],
      },
      {
        stageId: 'stage-3',
        name: 'Third stage',
        nodes: [makeNode({ nodeId: 'stage-3:bee', label: 'stage-3-uploader', chequebook: null })],
      },
    ],
    ...over,
  };
}

/**
 * One deposit of a chequebook bulk: 0.5 xBZZ into the main stage's uploader's chequebook, to a target of 2 xBZZ, sent
 * and not yet confirmed, so it holds up a new chequebook bulk (`settled` false) and is under way rather than watched
 * (`watched` false), as the API answers it.
 */
export function makeChequebookItem(over: Partial<FundingChequebookItem> = {}): FundingChequebookItem {
  return {
    requestId: 'chequebook-request-1',
    nodeId: 'stage-1:bee',
    nodeLabel: 'stage-1-uploader',
    direction: 'deposit',
    amountPlur: xbzz('0.5'),
    targetPlur: xbzz('2'),
    state: 'submitted',
    txHash: null,
    error: null,
    settled: false,
    watched: false,
    ...over,
  };
}
