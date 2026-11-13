import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ARCHIVE_MAX_DEPTH, ARCHIVE_MIN_DEPTH, archiveEffectiveChunks } from '@streaming-monorepo/contracts';

import {
  ARCHIVE_ACTIONS,
  ARCHIVE_BADGE_TEXT,
  ARCHIVE_BUY_MIN_DAYS,
  ARCHIVE_PATH,
  ARCHIVE_STAMP_PURCHASES_PATH,
  ARCHIVE_STAMPS_PATH,
  ARCHIVE_STREAMS_PATH,
  ARCHIVED_STATES,
  archiveActionPath,
  archiveBuyProblem,
  archiveBuyQuote,
  archiveHoldsPlace,
  archivePauseNeedsDecision,
  archiveStampPurchasePath,
  isArchived,
  streamArchiveListingPath,
  streamArchivePath,
  streamArchiveState,
  type ArchiveJobState,
  type ArchivePauseReason,
  type QualityArchiveState,
} from './archive.js';

const STREAM_ID = '0b8f6a3e-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const postage = () => ({ pricePerChunkPerBlockPlur: '24000', blockSeconds: 5, minimumValidityBlocks: 17280 });
// 30 days of 5 second blocks at 24000 PLUR a chunk a block.
const THIRTY_DAYS_AMOUNT = (24000n * 518400n).toString();

describe('the archive paths', () => {
  it('names the job, the stamps, the purchases and the Archive page under one prefix', () => {
    assert.equal(ARCHIVE_PATH, '/api/archive');
    assert.equal(ARCHIVE_STAMPS_PATH, '/api/archive/stamps');
    assert.equal(ARCHIVE_STAMP_PURCHASES_PATH, '/api/archive/stamp-purchases');
    assert.equal(ARCHIVE_STREAMS_PATH, '/api/archive/streams');
  });

  it("builds a stream's paths and a job's, each id escaped", () => {
    assert.equal(streamArchivePath(STREAM_ID), `/api/streams/${STREAM_ID}/archive`);
    assert.equal(streamArchiveListingPath(STREAM_ID), `/api/streams/${STREAM_ID}/archive/listing`);
    assert.equal(archiveActionPath(STREAM_ID), `/api/archive/${STREAM_ID}/actions`);
    assert.equal(archiveStampPurchasePath(STREAM_ID), `/api/archive/stamp-purchases/${STREAM_ID}`);
    assert.equal(streamArchivePath('a/b'), '/api/streams/a%2Fb/archive');
    assert.equal(archiveActionPath('../x'), '/api/archive/..%2Fx/actions');
  });
});

describe("a stream's archive state", () => {
  it('is none for a stream with no quality copied', () => {
    assert.equal(streamArchiveState([]), 'none');
    assert.equal(streamArchiveState(['none', 'none']), 'none');
  });

  it('is its best quality: one archived quality makes the stream archived', () => {
    assert.equal(streamArchiveState(['none', 'partial', 'complete']), 'complete');
    assert.equal(streamArchiveState(['reduced', 'partial']), 'reduced');
    assert.equal(streamArchiveState(['complete', 'reduced', 'expired']), 'complete');
  });

  it('ranks what is left: outdated over expired over partial', () => {
    assert.equal(streamArchiveState(['partial', 'expired', 'outdated']), 'outdated');
    assert.equal(streamArchiveState(['partial', 'expired']), 'expired');
    assert.equal(streamArchiveState(['none', 'partial']), 'partial');
  });

  it('counts complete and reduced as archived, and nothing else', () => {
    assert.deepEqual(ARCHIVED_STATES, ['complete', 'reduced']);
    const states: QualityArchiveState[] = ['none', 'partial', 'complete', 'reduced', 'outdated', 'expired'];
    assert.deepEqual(states.filter(isArchived), ['complete', 'reduced']);
  });

  it('has a badge for every state but none', () => {
    assert.equal(ARCHIVE_BADGE_TEXT.none, null);
    assert.equal(ARCHIVE_BADGE_TEXT.complete, 'Archived');
    assert.equal(ARCHIVE_BADGE_TEXT.reduced, 'Archived, reduced protection');
    assert.equal(ARCHIVE_BADGE_TEXT.partial, 'Archive incomplete');
    assert.equal(ARCHIVE_BADGE_TEXT.outdated, 'Archive outdated');
    assert.equal(ARCHIVE_BADGE_TEXT.expired, 'Archive expired');
  });
});

describe('the one place a job has', () => {
  const running: ArchiveJobState[] = ['measuring', 'buying', 'waiting_usable', 'copying', 'verifying', 'waiting'];

  it('is held while the archive works or waits by itself', () => {
    for (const state of running) assert.equal(archiveHoldsPlace(state, null), true, state);
  });

  it('is given up by a finished archive, one a user paused, and one waiting for a purchase confirm', () => {
    assert.equal(archiveHoldsPlace('done', null), false);
    assert.equal(archiveHoldsPlace('paused', 'user'), false);
    assert.equal(archiveHoldsPlace('awaiting_purchase', null), false);
  });

  it('is kept through every pause that is not a user’s own', () => {
    const reasons: ArchivePauseReason[] = ['unreadable', 'live', 'batch', 'node', 'funds', 'problem'];
    for (const reason of reasons) assert.equal(archiveHoldsPlace('paused', reason), true, reason);
  });

  it('asks for a decision on every pause but a user’s own', () => {
    assert.equal(archivePauseNeedsDecision(null), false);
    assert.equal(archivePauseNeedsDecision('user'), false);
    for (const reason of ['unreadable', 'live', 'batch', 'node', 'funds', 'problem'] as const) {
      assert.equal(archivePauseNeedsDecision(reason), true, reason);
    }
  });

  it('names every action once', () => {
    assert.deepEqual(ARCHIVE_ACTIONS, [
      'pause',
      'resume',
      'wait',
      'confirm_purchase',
      'use_stamp',
      'buy_new',
      'cancel',
      'dismiss',
    ]);
  });
});

describe('the rows of a buy dialog', () => {
  it('start at the smallest depth that holds the recording, and go on to the deepest, so a bigger one can be bought', () => {
    const quote = archiveBuyQuote({ chunks: 650_000, days: 30, postage: postage() });
    assert.equal(quote.chunksNeeded, 682_500);
    assert.equal(quote.defaultDepth, 22);
    assert.equal(quote.rows[0]!.depth, 22);
    assert.equal(quote.rows.at(-1)!.depth, ARCHIVE_MAX_DEPTH);
    assert.deepEqual(
      quote.rows.map((row) => row.depth),
      Array.from({ length: ARCHIVE_MAX_DEPTH - 22 + 1 }, (_, step) => 22 + step),
    );
  });

  it('are every depth when no recording is being sized, as on the Stamps tab', () => {
    const quote = archiveBuyQuote({ days: 30, postage: postage() });
    assert.equal(quote.chunksNeeded, null);
    assert.equal(quote.defaultDepth, ARCHIVE_MIN_DEPTH);
    assert.equal(quote.rows.length, ARCHIVE_MAX_DEPTH - ARCHIVE_MIN_DEPTH + 1);
    assert.deepEqual(archiveBuyQuote({ chunks: null, days: 30, postage: postage() }), quote);
  });

  it('give each row what its depth holds and what it costs for the days', () => {
    const [row] = archiveBuyQuote({ chunks: 650_000, days: 30, postage: postage() }).rows;
    assert.equal(row!.effectiveBytes, 7_730_000_000);
    assert.equal(row!.effectiveChunks, archiveEffectiveChunks(22));
    assert.equal(row!.amountPerChunkPlur, THIRTY_DAYS_AMOUNT);
    assert.equal(row!.costPlur, (BigInt(THIRTY_DAYS_AMOUNT) * 2n ** 22n).toString());
  });

  it('doubles the cost with each depth, at one amount for each chunk', () => {
    const { rows } = archiveBuyQuote({ days: 30, postage: postage() });
    for (let at = 1; at < rows.length; at++) {
      assert.equal(rows[at]!.amountPerChunkPlur, rows[0]!.amountPerChunkPlur);
      assert.equal(BigInt(rows[at]!.costPlur), BigInt(rows[at - 1]!.costPlur) * 2n, `depth ${rows[at]!.depth}`);
    }
  });

  it('rounds the blocks up, so the days are never short', () => {
    const quote = archiveBuyQuote({ days: 2, postage: { ...postage(), blockSeconds: 7 } });
    assert.equal(quote.rows[0]!.amountPerChunkPlur, (24000n * 24686n).toString());
  });

  it('has no row and no depth to start on for a recording no depth holds', () => {
    const quote = archiveBuyQuote({ chunks: archiveEffectiveChunks(ARCHIVE_MAX_DEPTH), days: 30, postage: postage() });
    assert.equal(quote.defaultDepth, null);
    assert.deepEqual(quote.rows, []);
  });

  it('refuses days under the least a stamp lasts, and days that are no whole number', () => {
    assert.equal(ARCHIVE_BUY_MIN_DAYS, 2);
    for (const days of [0, 1, 2.5, Number.NaN]) {
      assert.throws(() => archiveBuyQuote({ days, postage: postage() }), RangeError, String(days));
    }
  });
});

describe('whether a choice can be bought', () => {
  const choice = () => ({ depth: 22, amountPerChunkPlur: THIRTY_DAYS_AMOUNT, label: 'Autumn event' });
  const cost = BigInt(THIRTY_DAYS_AMOUNT) * 2n ** 22n;
  const terms = () => ({ postage: postage(), walletXbzzPlur: cost.toString(), walletXdaiWei: '1' });

  it('passes a choice the wallet covers, of a depth that holds the recording, for the least days or more', () => {
    assert.equal(archiveBuyProblem(choice(), terms()), null);
    assert.equal(archiveBuyProblem(choice(), terms(), archiveEffectiveChunks(22)), null);
    assert.equal(archiveBuyProblem({ ...choice(), depth: 30 }, { ...terms(), walletXbzzPlur: null }), null);
  });

  it('refuses a depth the table does not name, and one too shallow for the recording', () => {
    assert.match(archiveBuyProblem({ ...choice(), depth: 16 }, terms())!, /17 to 41/);
    assert.match(archiveBuyProblem({ ...choice(), depth: 42 }, terms())!, /17 to 41/);
    assert.match(archiveBuyProblem(choice(), terms(), archiveEffectiveChunks(22) + 1)!, /this recording needs/);
  });

  it('refuses an amount that is no whole number above 0, and one that buys under the least days', () => {
    for (const amountPerChunkPlur of ['0', '', '1.5', '-1']) {
      assert.match(archiveBuyProblem({ ...choice(), amountPerChunkPlur }, terms())!, /whole number of PLUR/);
    }
    const oneDay = (24000n * 17280n).toString();
    assert.match(archiveBuyProblem({ ...choice(), amountPerChunkPlur: oneDay }, terms())!, /2 days or more/);
  });

  it('says what the wallet is short of, and that it needs xDAI for the gas', () => {
    const short = archiveBuyProblem(choice(), { ...terms(), walletXbzzPlur: (cost - 5n).toString() });
    assert.match(short!, /is 5 PLUR short/);
    assert.match(archiveBuyProblem(choice(), { ...terms(), walletXdaiWei: '0' })!, /no xDAI/);
  });

  it('cannot price a stamp without the price of postage', () => {
    assert.match(archiveBuyProblem(choice(), { ...terms(), postage: null })!, /could not be read/);
  });
});
