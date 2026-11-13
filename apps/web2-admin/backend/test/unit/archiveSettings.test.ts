/**
 * The archive's settings and the shapes its routes take: defaults, bounds and the sentences a bad value stops the
 * start with, and the request bodies the edge accepts. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  archiveActionSchema,
  archiveBuySchema,
  archiveListingSchema,
  archiveStartSchema,
} from '../../src/schemas/archive.js';
import { archiveSettingsFrom, bzzToPlur } from '../../src/utils/archiveSettings.js';

describe('archive settings', () => {
  it('default to 16 chunks at once, a 2000-chunk window, a 0.1 BZZ floor, 30 days of warning and of new stamps', () => {
    assert.deepEqual(archiveSettingsFrom({}), {
      parallelChunks: 16,
      pushWindowChunks: 2_000,
      chequebookFloorPlur: '1000000000000000',
      ttlWarningDays: 30,
      buyDefaultDays: 30,
    });
  });

  it('take values within bounds, and a floor of 0 that never pauses', () => {
    const settings = archiveSettingsFrom({
      ARCHIVE_PARALLEL_CHUNKS: '64',
      ARCHIVE_PUSH_WINDOW_CHUNKS: '100',
      ARCHIVE_CHEQUEBOOK_FLOOR_BZZ: '0',
      ARCHIVE_TTL_WARNING_DAYS: '7',
      ARCHIVE_BUY_DEFAULT_DAYS: '2',
    });
    assert.equal(settings.parallelChunks, 64);
    assert.equal(settings.pushWindowChunks, 100);
    assert.equal(settings.chequebookFloorPlur, '0');
    assert.equal(settings.ttlWarningDays, 7);
    assert.equal(settings.buyDefaultDays, 2);
  });

  it('stop the start on a value out of bounds or not a number, naming the key', () => {
    assert.throws(
      () => archiveSettingsFrom({ ARCHIVE_PARALLEL_CHUNKS: '65' }),
      /ARCHIVE_PARALLEL_CHUNKS must be a whole number from 1 to 64/,
    );
    assert.throws(() => archiveSettingsFrom({ ARCHIVE_PUSH_WINDOW_CHUNKS: '1e3' }), /ARCHIVE_PUSH_WINDOW_CHUNKS/);
    assert.throws(
      () => archiveSettingsFrom({ ARCHIVE_BUY_DEFAULT_DAYS: '1' }),
      /ARCHIVE_BUY_DEFAULT_DAYS must be a whole number from 2/,
    );
    assert.throws(
      () => archiveSettingsFrom({ ARCHIVE_CHEQUEBOOK_FLOOR_BZZ: '-1' }),
      /ARCHIVE_CHEQUEBOOK_FLOOR_BZZ must be an amount of BZZ/,
    );
  });

  it('read BZZ as PLUR, to 16 decimals', () => {
    assert.equal(bzzToPlur('1'), 10n ** 16n);
    assert.equal(bzzToPlur('0.0000000000000001'), 1n);
    assert.equal(bzzToPlur('2.5'), 25n * 10n ** 15n);
    assert.equal(bzzToPlur('0.00000000000000001'), null, 'beyond 16 decimals');
    assert.equal(bzzToPlur('abc'), null);
  });
});

describe('the archive routes take', () => {
  it('a start with qualities and a stamp, or a new one to buy, and nothing else', async () => {
    const batchId = 'a'.repeat(64);
    assert.ok(await archiveStartSchema.isValid({ renditions: ['720p'], target: { batchId } }));
    assert.ok(await archiveStartSchema.isValid({ renditions: ['source'], target: { batchId: `0x${batchId}` } }));
    assert.ok(await archiveStartSchema.isValid({ renditions: ['720p'], target: { buyNew: true } }));
    assert.ok(!(await archiveStartSchema.isValid({ renditions: [], target: { buyNew: true } })));
    assert.ok(!(await archiveStartSchema.isValid({ renditions: ['720p'], target: { buyNew: false } })));
    assert.ok(!(await archiveStartSchema.isValid({ renditions: ['720p'], target: { batchId: 'nope' } })));
    assert.ok(!(await archiveStartSchema.isValid({ renditions: ['720p'], target: { batchId, buyNew: true } })));
    assert.ok(!(await archiveStartSchema.isValid({ renditions: ['../x'], target: { buyNew: true } })));
  });

  it('an action, with the stamp a change needs, and a buy choice of depth, days, label and the cost shown', async () => {
    assert.ok(await archiveActionSchema.isValid({ action: 'pause' }));
    assert.ok(!(await archiveActionSchema.isValid({ action: 'confirm_purchase' })), 'confirmed on its own route');
    const choice = { depth: 20, days: 30, label: null, costPlur: '13045726248960000' };
    assert.ok(await archiveBuySchema.isValid(choice));
    assert.ok(!(await archiveBuySchema.isValid({ ...choice, days: 1 })));
    assert.ok(!(await archiveBuySchema.isValid({ ...choice, costPlur: '0' })));
    assert.ok(!(await archiveBuySchema.isValid({ depth: 20, label: null, costPlur: '1' })), 'days are required');
    assert.ok(await archiveActionSchema.isValid({ action: 'use_stamp', batchId: 'b'.repeat(64) }));
    assert.ok(!(await archiveActionSchema.isValid({ action: 'use_stamp' })));
    assert.ok(!(await archiveActionSchema.isValid({ action: 'archive_everything' })));
  });

  it('a listing switch that is on or off', async () => {
    assert.ok(await archiveListingSchema.isValid({ archivedOnly: true }));
    assert.ok(!(await archiveListingSchema.isValid({ archivedOnly: 'yes' })));
  });
});
