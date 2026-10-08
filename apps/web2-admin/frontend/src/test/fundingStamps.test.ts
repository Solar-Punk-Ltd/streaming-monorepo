import { describe, expect, it } from 'vitest';
import type { FundingView } from '@streaming-monorepo/web2-admin-common';

import {
  acceptsDaysTyping,
  allBatchRows,
  batchGroups,
  checkStamps,
  DAYS_PROBLEM,
  EXPIRED_TEXT,
  NO_PRICE_PROBLEM,
  NOT_READ_IN_FULL_TEXT,
  NOT_USABLE_TEXT,
  readDays,
  reportsBatches,
  whyNotOperable,
  type StampSelection,
} from '../components/funding/stamps';
import {
  BATCH,
  DAY,
  makeBatch,
  makeNode,
  makeStampView,
  makeView,
  POSTAGE,
  THIRTY_DAYS_DEPTH_20,
  unreadBatch,
} from './fundingFixtures';

/** The price of postage the view shows, which every top-up is quoted at and asked for with. */
const PRICE = POSTAGE.pricePerChunkPerBlockPlur;

/** A top-up of 30 days, or the operation and days given, with these batches ticked. */
function selection(ticked: string[], over: Partial<StampSelection> = {}): StampSelection {
  return { operation: 'topup', days: '30', steps: 1, ticked: new Set(ticked), ...over };
}

/** What 30 days cost the main stage's batch of depth 22: four times a batch of depth 20. */
const THIRTY_DAYS_DEPTH_22 = (BigInt(THIRTY_DAYS_DEPTH_20) * 4n).toString();

/** Every node holds 5 xBZZ. */
const FIVE_XBZZ = 50_000_000_000_000_000n;

describe('the batches, grouped', () => {
  it('puts the catalogue batch on top, then each stage, with a row for each node that has a batch', () => {
    const groups = batchGroups(makeStampView());
    expect(
      groups.map((group) => [group.title, group.nodes.catalogue, group.rows.map((row) => row.node.label)]),
    ).toEqual([
      ['Catalogue batch', true, ['catalogue-node']],
      ['Main stage', false, ['stage-1-uploader', 'rung-720p', 'rung-1080p']],
      ['Second stage', false, ['pool-360p']],
    ]);
  });

  it('keeps a stage with no batch, and a catalogue node without one, as a group with no rows', () => {
    const groups = batchGroups(makeView());
    expect(groups.map((group) => [group.title, group.rows.length])).toEqual([
      ['Catalogue batch', 0],
      ['Main stage', 0],
      ['Second stage', 0],
    ]);
  });

  it('lists a batch two stages share once, under the node that lists it first', () => {
    const pooled = `0x${'ff'.repeat(32)}`;
    const shared = makeNode({
      nodeId: 'pool:720p',
      label: 'Main stage 720p rung',
      batch: makeBatch({ batchId: pooled }),
    });
    const view = makeStampView();
    view.stages[0]?.nodes.push(shared);
    view.stages[1]?.nodes.push({ ...shared, label: 'Second stage 720p rung' });
    expect(batchGroups(view).filter((group) => group.rows.some((row) => row.batch.batchId === pooled))).toHaveLength(2);
    const rows = allBatchRows(view).filter((row) => row.batch.batchId === pooled);
    expect(rows.map((row) => row.node.label)).toEqual(['Main stage 720p rung']);
    expect(allBatchRows(view).map((row) => row.batch.batchId)).toEqual([
      BATCH.catalogue,
      BATCH.stage,
      BATCH.expired,
      BATCH.unread,
      pooled,
      BATCH.rung,
    ]);
  });

  it('knows whether the manager reports batches at all, which one older than the Stamps tab does not', () => {
    expect(reportsBatches(makeView())).toBe(false);
    expect(reportsBatches(makeStampView())).toBe(true);
    const none = makeView();
    if (none.catalogue) none.catalogue = { ...none.catalogue, batch: null };
    expect(reportsBatches(none)).toBe(true);
  });
});

describe('which batches can be ticked', () => {
  it('ticks a batch read whole, usable and not expired', () => {
    expect(whyNotOperable(makeBatch())).toBeNull();
  });

  it('says why it cannot tick one: the read error, expired, not usable, or not read in full', () => {
    expect(whyNotOperable(unreadBatch())).toBe('The node did not answer in time.');
    expect(whyNotOperable(makeBatch({ ttlSeconds: 0, usable: false }))).toBe(EXPIRED_TEXT);
    expect(whyNotOperable(makeBatch({ usable: false }))).toBe(NOT_USABLE_TEXT);
    expect(whyNotOperable(makeBatch({ ttlSeconds: null }))).toBe(NOT_READ_IN_FULL_TEXT);
    expect(whyNotOperable(makeBatch({ usable: null }))).toBe(NOT_READ_IN_FULL_TEXT);
    expect(whyNotOperable(makeBatch({ readError: '' }))).toBe(NOT_READ_IN_FULL_TEXT);
  });
});

describe('the days of a top-up', () => {
  it('takes any whole number of days from 1, with no cap', () => {
    for (const [typed, days] of [
      ['1', 1],
      ['30', 30],
      [' 7 ', 7],
      ['365', 365],
      ['4000', 4000],
      ['007', 7],
    ] as const) {
      expect(readDays(typed), typed).toEqual({ kind: 'ok', days });
    }
  });

  it('refuses nothing, zero, a fraction, a sign, a letter and more than a whole number holds', () => {
    for (const typed of ['', '0', '1.5', '-1', '+3', '3d', '9'.repeat(20)]) {
      expect(readDays(typed), typed).toEqual({ kind: 'invalid', problem: DAYS_PROBLEM });
    }
  });

  it('lets only digits into the field as they are typed', () => {
    for (const typed of ['', '1', '30', '007']) expect(acceptsDaysTyping(typed), typed).toBe(true);
    for (const typed of ['1.', '-', '3 ', 'a', '1e3']) expect(acceptsDaysTyping(typed), typed).toBe(false);
  });
});

describe('what a top-up comes to', () => {
  it('asks for nothing with nothing ticked', () => {
    const check = checkStamps(makeStampView(), selection([]));
    expect(check.lines).toEqual([]);
    expect(check.problems).toEqual(['Tick a batch to top it up.']);
    expect(check.totalCostPlur).toBe('0');
  });

  it('asks for each ticked batch at the depth and the price it shows, with its cost at that price and its time left after', () => {
    const check = checkStamps(makeStampView(), selection([BATCH.catalogue, BATCH.rung]));
    expect(check.problems).toEqual([]);
    expect(check.lines.map((line) => line.request)).toEqual([
      {
        kind: 'topup',
        nodeId: 'catalogue:bee',
        batchId: BATCH.catalogue,
        expectedDepth: 20,
        days: 30,
        pricePerChunkPerBlockPlur: PRICE,
      },
      {
        kind: 'topup',
        nodeId: 'stage-2:360p',
        batchId: BATCH.rung,
        expectedDepth: 20,
        days: 30,
        pricePerChunkPerBlockPlur: PRICE,
      },
    ]);
    expect(check.lineOf.get(BATCH.catalogue)).toMatchObject({
      costPlur: THIRTY_DAYS_DEPTH_20,
      ttlAfterSeconds: 70 * DAY,
    });
    expect(check.lineOf.get(BATCH.rung)).toMatchObject({ costPlur: THIRTY_DAYS_DEPTH_20, ttlAfterSeconds: 40 * DAY });
    expect(check.totalCostPlur).toBe((BigInt(THIRTY_DAYS_DEPTH_20) * 2n).toString());
    expect(check.ledgerOf.get('catalogue:bee')).toEqual({
      costPlur: THIRTY_DAYS_DEPTH_20,
      afterPlur: (FIVE_XBZZ - BigInt(THIRTY_DAYS_DEPTH_20)).toString(),
      shortPlur: null,
      fundPlur: null,
    });
  });

  it('quotes each top-up at the price of postage the view shows, which the request names', () => {
    const view = makeStampView({ postage: { ...POSTAGE, pricePerChunkPerBlockPlur: '48000' } });
    const check = checkStamps(view, selection([BATCH.catalogue]));
    expect(check.lines[0]?.request).toMatchObject({ kind: 'topup', pricePerChunkPerBlockPlur: '48000' });
    expect(check.lines[0]?.costPlur).toBe((BigInt(THIRTY_DAYS_DEPTH_20) * 2n).toString());
  });

  it('says what a node lacks for its top-ups, exactly and rounded up to three decimals', () => {
    const check = checkStamps(makeStampView(), selection([BATCH.stage]));
    expect(check.lineOf.get(BATCH.stage)?.costPlur).toBe(THIRTY_DAYS_DEPTH_22);
    expect(check.ledgerOf.get('stage-1:bee')).toEqual({
      costPlur: THIRTY_DAYS_DEPTH_22,
      afterPlur: null,
      shortPlur: '2183852646400000',
      fundPlur: '2190000000000000',
    });
    expect(check.problems).toEqual(['stage-1-uploader is short of 0.219 xBZZ for its top-ups.']);
  });

  it('counts every batch a node pays for against its one wallet', () => {
    // The catalogue node is the main stage's own node here, with the catalogue batch and the stage's batch.
    const view = makeStampView();
    if (view.catalogue) view.catalogue = { ...view.catalogue, nodeId: 'stage-1:bee' };
    const check = checkStamps(view, selection([BATCH.catalogue, BATCH.stage], { days: '7' }));
    const sevenDays = 120_960n * 24_000n * 2n ** 20n;
    const cost = sevenDays + sevenDays * 4n;
    expect(check.ledgerOf.get('stage-1:bee')).toEqual({
      costPlur: cost.toString(),
      afterPlur: (FIVE_XBZZ - cost).toString(),
      shortPlur: null,
      fundPlur: null,
    });
    expect(check.ledgerOf.size).toBe(1);
  });

  it('asks for a batch two stages share once, and counts it once against its node', () => {
    const pooled = `0x${'ff'.repeat(32)}`;
    const shared = makeNode({ nodeId: 'pool:720p', label: 'shared-720p', batch: makeBatch({ batchId: pooled }) });
    const view = makeStampView();
    view.stages[0]?.nodes.push(shared);
    view.stages[1]?.nodes.push(shared);
    const check = checkStamps(view, selection([pooled]));
    expect(check.lines.map((line) => line.request)).toEqual([
      {
        kind: 'topup',
        nodeId: 'pool:720p',
        batchId: pooled,
        expectedDepth: 20,
        days: 30,
        pricePerChunkPerBlockPlur: PRICE,
      },
    ]);
    expect(check.ledgerOf.get('pool:720p')?.costPlur).toBe(THIRTY_DAYS_DEPTH_20);
  });

  it('never counts a tick left on a batch that can no longer be ticked', () => {
    const check = checkStamps(makeStampView(), selection([BATCH.expired, BATCH.unread]));
    expect(check.lines).toEqual([]);
    expect(check.problems).toEqual(['Tick a batch to top it up.']);
  });

  it('cannot price a top-up without days it can read or without the price of postage', () => {
    const noDays = checkStamps(makeStampView(), selection([BATCH.catalogue], { days: '' }));
    expect(noDays.problems).toEqual([DAYS_PROBLEM]);
    expect(noDays.lines[0]).toMatchObject({ request: null, costPlur: null, ttlAfterSeconds: null });
    expect(noDays.totalCostPlur).toBeNull();

    // A top-up names the price it was quoted at, so with none there is nothing to ask for.
    const noPrice = checkStamps(makeStampView({ postage: null }), selection([BATCH.catalogue]));
    expect(noPrice.problems).toEqual([NO_PRICE_PROBLEM]);
    expect(noPrice.lines[0]).toMatchObject({ request: null, costPlur: null, ttlAfterSeconds: null });
    expect(noPrice.ledgerOf.size).toBe(0);
    expect(noPrice.totalCostPlur).toBeNull();
  });

  it('cannot ask a node with no xDAI for the gas, or one whose wallet was not read', () => {
    const view = makeStampView();
    if (view.catalogue) view.catalogue = { ...view.catalogue, xdaiWei: '0' };
    if (view.stages[1]?.nodes[0])
      view.stages[1].nodes[0] = { ...view.stages[1].nodes[0], xdaiWei: null, xbzzPlur: null };
    const check = checkStamps(view, selection([BATCH.catalogue, BATCH.rung]));
    expect(check.problems).toEqual([
      'catalogue-node holds no xDAI to pay the gas.',
      'The wallet of pool-360p could not be read.',
    ]);
    expect(check.ledgerOf.has('stage-2:360p')).toBe(false);
  });
});

describe('what a dilution comes to', () => {
  const dilute = (ticked: string[], steps: 1 | 2 = 1, view: FundingView = makeStampView()) =>
    checkStamps(view, selection(ticked, { operation: 'dilute', steps }));

  it('asks for each ticked batch one or two steps deeper, and halves its time left for each', () => {
    const one = dilute([BATCH.catalogue]);
    expect(one.problems).toEqual([]);
    expect(one.lines[0]).toMatchObject({
      request: { kind: 'dilute', nodeId: 'catalogue:bee', batchId: BATCH.catalogue, expectedDepth: 20, steps: 1 },
      newDepth: 21,
      ttlAfterSeconds: 20 * DAY,
      costPlur: null,
      problem: null,
    });
    expect(dilute([BATCH.catalogue], 2).lines[0]).toMatchObject({ newDepth: 22, ttlAfterSeconds: 10 * DAY });
    expect(one.totalCostPlur).toBeNull();
    expect(one.ledgerOf.size).toBe(0);
  });

  it('refuses one that would leave its batch under 7 days, in the quote’s own words', () => {
    const check = dilute([BATCH.catalogue, BATCH.stage]);
    expect(check.lineOf.get(BATCH.stage)).toMatchObject({
      ttlAfterSeconds: 6 * DAY,
      problem: 'It would leave the batch under 7 days.',
    });
    expect(check.problems).toEqual([
      'The batch 0xbbbbbb…bbbbbb of stage-1-uploader: It would leave the batch under 7 days.',
    ]);
    expect(dilute([BATCH.catalogue], 2).problems).toEqual([]);
  });

  it('refuses one that would take its batch past depth 40, the manager’s ceiling, in the quote’s own words', () => {
    const view = makeStampView();
    if (view.catalogue) view.catalogue = { ...view.catalogue, batch: makeBatch({ depth: 39, ttlSeconds: 365 * DAY }) };
    const check = dilute([BATCH.catalogue], 2, view);
    expect(check.lineOf.get(BATCH.catalogue)).toMatchObject({
      newDepth: 41,
      problem: 'It would take the batch past depth 40, the deepest the manager dilutes a batch to.',
    });
    expect(check.problems).toEqual([
      'The batch 0xaaaaaa…aaaaaa of catalogue-node: It would take the batch past depth 40, the deepest the manager dilutes a batch to.',
    ]);
    expect(dilute([BATCH.catalogue], 1, view).problems).toEqual([]);
  });

  it('pays no xBZZ, so a node short of it may dilute, but not one with no xDAI for the gas', () => {
    const poor = makeStampView();
    if (poor.catalogue) poor.catalogue = { ...poor.catalogue, xbzzPlur: '0' };
    expect(dilute([BATCH.catalogue], 1, poor).problems).toEqual([]);
    if (poor.catalogue) poor.catalogue = { ...poor.catalogue, xdaiWei: '0' };
    expect(dilute([BATCH.catalogue], 1, poor).problems).toEqual(['catalogue-node holds no xDAI to pay the gas.']);
  });

  it('asks for nothing with nothing ticked', () => {
    expect(dilute([]).problems).toEqual(['Tick a batch to dilute it.']);
  });
});
