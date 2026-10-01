/**
 * Every batch reading the console is shown, aged to the moment the admin answers. Unit test: the presenters of
 * `GET /api/stages` and `GET /api/catalogue-stamp`, over rows from the in-memory stores, with the admin's clock set
 * by hand. `pnpm test`.
 *
 * Pinned here: a reading the manager has not refreshed is shown with the time its time to live has left now, and as
 * expired by the clock once that has run out, the way the catalogue's refusal counts it; the reading itself
 * (`ttlSeconds`, `observedAt`) is answered as it was pushed; and a reading that is null stays null. Before this, the
 * Stages page went on saying "3 days 0 h left" of a batch the admin had started refusing as expired.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toCatalogueStampSummary, toStageSummary } from '../../src/api/presenters.js';
import { splitStageRecord } from '../../src/domain/StageService.js';
import { isDesignated, type DesignatedCatalogueStamp, type StageRow } from '../../src/types/index.js';

import {
  BATCH_ID,
  catalogueStampRecord,
  FakeCatalogueStampStore,
  FakeStageStore,
  stageRecord,
} from './support/stageFakes.js';

const DAY = 86_400;
const READ_AT = '2026-09-28T10:00:00.000Z';
const JUST_NOW = Date.parse(READ_AT);
const THREE_DAYS_LATER = Date.parse('2026-10-01T10:00:00.000Z');

async function catalogueRow(ttlSeconds: number | null): Promise<DesignatedCatalogueStamp> {
  const store = new FakeCatalogueStampStore();
  await store.upsert(catalogueStampRecord({ ttlSeconds, observedAt: READ_AT }));
  const row = await store.get();
  assert.ok(isDesignated(row));
  return row;
}

/** A stage read at READ_AT with a 720p rung on a batch with two days left, and a 480p rung with no reading at all. */
async function stageRow(): Promise<StageRow> {
  const row = await new FakeStageStore().upsert(
    splitStageRecord(
      stageRecord({
        observedAt: READ_AT,
        rungs: [
          {
            name: '720p',
            stamp: { batchId: BATCH_ID, state: 'active', ttlSeconds: 2 * DAY, fillRatio: 0.25, immutable: true },
            chequebook: { health: 'ok', availableBzz: '12.5' },
          },
          { name: '480p', stamp: null, chequebook: null },
        ],
      }),
    ),
  );
  assert.ok(row);
  return row;
}

describe('toCatalogueStampSummary', () => {
  it('presents a reading taken three days ago with two days to live as expired by the clock, the reading as it was', async () => {
    const summary = toCatalogueStampSummary(await catalogueRow(2 * DAY), THREE_DAYS_LATER);

    assert.equal(summary.state, 'active');
    assert.equal(summary.ttlSeconds, 2 * DAY);
    assert.equal(summary.observedAt, READ_AT);
    assert.equal(summary.remainingSeconds, 0);
    assert.equal(summary.expiredByClock, true);
  });

  it('presents a reading taken just now with its whole time to live', async () => {
    const summary = toCatalogueStampSummary(await catalogueRow(2 * DAY), JUST_NOW);

    assert.equal(summary.remainingSeconds, 2 * DAY);
    assert.equal(summary.expiredByClock, false);
  });

  it('presents a time to live the node did not give as unknown, however old the reading', async () => {
    const summary = toCatalogueStampSummary(await catalogueRow(null), THREE_DAYS_LATER);

    assert.equal(summary.ttlSeconds, null);
    assert.equal(summary.remainingSeconds, null);
    assert.equal(summary.expiredByClock, false);
  });
});

describe('toStageSummary', () => {
  it('ages each rung’s reading by the moment the manager read the stage, and leaves a rung with none null', async () => {
    const row = await stageRow();

    const later = toStageSummary(row, THREE_DAYS_LATER);
    assert.deepEqual(later.rungs[0]?.stamp, {
      batchId: BATCH_ID,
      state: 'active',
      ttlSeconds: 2 * DAY,
      remainingSeconds: 0,
      expiredByClock: true,
      fillRatio: 0.25,
      immutable: true,
    });
    assert.equal(later.rungs[1]?.stamp, null);
    assert.equal(later.observedAt, READ_AT);

    const now = toStageSummary(row, JUST_NOW);
    assert.equal(now.rungs[0]?.stamp?.remainingSeconds, 2 * DAY);
    assert.equal(now.rungs[0]?.stamp?.expiredByClock, false);
    assert.equal(now.rungs[1]?.stamp, null);
  });
});
