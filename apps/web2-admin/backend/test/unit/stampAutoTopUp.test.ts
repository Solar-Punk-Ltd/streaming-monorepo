/**
 * Stamp auto top-up's settings view and its four writes, against the in-memory store and the fake manager. Unit test —
 * no database. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTO_TOPUP_DEFAULTS,
  autoTopUpMonthlyEstimatePlur,
  autoTopUpStampPlan,
} from '@streaming-monorepo/web2-admin-common';

import {
  AutoTopUpNotMarkableError,
  FundingManagerUnavailableError,
  FundingRefusedError,
  RequestShapeError,
} from '../../src/domain/errors/index.js';
import { StampAutoTopUpService } from '../../src/domain/funding/StampAutoTopUpService.js';

import { InMemoryStampAutoTopUpStore } from './support/autoTopUpFakes.js';
import { InMemoryAuditLog, TEST_OPERATOR } from './support/fakes.js';
import {
  BATCH_CATALOGUE,
  BATCH_RUNG,
  BATCH_STAGE,
  DAY,
  FakeFundingManager,
  fundingBatch,
  InMemoryFundingStampStore,
  InMemoryFundingTransferStore,
  NODE_A,
  NODE_B,
  NODE_CATALOGUE,
  NODE_RUNG,
  POSTAGE,
  stampInventory,
} from './support/fundingFakes.js';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const BATCH_ARCHIVE = `0x${'e4'.repeat(32)}`;

function setup(over: { manager?: FakeFundingManager | null; mail?: boolean } = {}) {
  const transfers = new InMemoryFundingTransferStore();
  const stamps = new InMemoryFundingStampStore();
  const store = new InMemoryStampAutoTopUpStore({ transfers, stamps });
  const manager = over.manager === undefined ? new FakeFundingManager() : over.manager;
  if (manager) manager.inventoryAnswer = stampInventory();
  const audit = new InMemoryAuditLog();
  const service = new StampAutoTopUpService({
    store,
    manager,
    audit,
    mailConfigured: () => over.mail ?? false,
    now: () => NOW,
  });
  return { store, manager, audit, service, transfers, stamps };
}

describe("stamp auto top-up's view", () => {
  it('answers the defaults, the three jobs, no stamps, and the mail as the service reads it', async () => {
    const { service } = setup({ mail: true });

    const view = await service.view();

    assert.deepEqual(view.settings, AUTO_TOPUP_DEFAULTS);
    assert.equal(view.settingsSavedBy, null);
    assert.equal(view.settingsSavedAt, null);
    assert.deepEqual(
      view.jobs.map((job) => [job.job, job.paused, job.lastRunAt]),
      [
        ['alert', false, null],
        ['wallet', false, null],
        ['stamp', false, null],
      ],
    );
    assert.deepEqual(view.emails, []);
    assert.deepEqual(view.mail, { configured: true, lastSentAt: null, lastError: null });
    assert.deepEqual(view.stamps, []);
    assert.equal(view.monthlyEstimatePlur, '0');
    assert.equal(view.dailyCeilingPlur, '0');
    assert.equal(view.sentTodayPlur, '0');
    assert.deepEqual(view.warnings, []);
  });

  it('has no estimate and no ceiling without a manager, or when it cannot be read, or without a price', async () => {
    assert.equal((await setup({ manager: null }).service.view()).monthlyEstimatePlur, null);

    const down = setup();
    down.manager!.inventoryError = new Error('the manager is down');
    const view = await down.service.view();
    assert.equal(view.monthlyEstimatePlur, null);
    assert.equal(view.dailyCeilingPlur, null);

    const unpriced = setup();
    unpriced.manager!.inventoryAnswer = { ...stampInventory(), chain: { ...stampInventory().chain, postage: null } };
    assert.equal((await unpriced.service.view()).dailyCeilingPlur, null);
  });

  it("shows each marked stamp's last top-up, its coming top-up and its problem, and the estimate and the ceiling", async () => {
    const { service, store, stamps, transfers, manager } = setup();
    const inventory = stampInventory();
    // The stage's batch with 7.5 days left: upcoming, within a look-ahead of the threshold.
    inventory.stages[0]!.nodes[0]!.batch = fundingBatch({ ttlSeconds: 7.5 * DAY });
    manager!.inventoryAnswer = inventory;
    await service.setMarks(TEST_OPERATOR, true, [
      { nodeId: NODE_A, batchId: BATCH_STAGE },
      { nodeId: NODE_CATALOGUE, batchId: BATCH_CATALOGUE },
    ]);
    const alertedAt = new Date(NOW - 3600_000);
    await store.setAlert(BATCH_STAGE, {
      days: 7,
      costPlur: '1000',
      costWithMarginPlur: '1100',
      sendPlur: '400',
      gasSend: false,
      recordedAt: alertedAt,
      alertedAt,
    });
    await store.raiseWarning({ kind: 'topup_failed', batchId: BATCH_CATALOGUE }, 'The top-up failed.', new Date(NOW));
    await stamps.insertAll([
      {
        requestId: '00000000-0000-4000-8000-000000000001',
        bulkId: '00000000-0000-4000-8000-0000000000b1',
        position: 0,
        nodeId: NODE_CATALOGUE,
        nodeLabel: 'Catalogue node',
        batchId: BATCH_CATALOGUE,
        kind: 'topup',
        days: 7,
        steps: null,
        expectedDepth: 18,
        newDepth: null,
        amountPerChunkPlur: '1',
        costPlur: '262144',
        requestedByUserId: null,
        requestedBy: 'stamp auto top-up',
        requestedByKind: 'system',
      },
    ]);
    await transfers.insertAll([
      {
        requestId: '00000000-0000-4000-8000-000000000002',
        bulkId: '00000000-0000-4000-8000-0000000000b2',
        nodeId: NODE_A,
        nodeLabel: 'Main stage uploader',
        toAddress: '0x1111111111111111111111111111111111111111',
        kind: 'xbzz',
        amount: '400',
        nonce: 1,
        rawTransaction: '0x02',
        txHash: `0x${'cd'.repeat(32)}`,
        requestedByUserId: null,
        requestedBy: 'stamp auto top-up',
        requestedByKind: 'system',
      },
    ]);

    const view = await service.view();

    const [stage, catalogue] = view.stamps;
    const plan = autoTopUpStampPlan({ depth: 20, ttlSeconds: 7.5 * DAY }, AUTO_TOPUP_DEFAULTS, POSTAGE);
    assert.equal(stage?.nodeLabel, 'Main stage uploader');
    assert.equal(stage?.markedBy, TEST_OPERATOR.username);
    assert.deepEqual(stage?.coming, {
      due: false,
      dueAt: new Date(NOW + plan.dueInSeconds * 1000).toISOString(),
      days: 7,
      costPlur: '1000',
      costWithMarginPlur: '1100',
      sendPlur: '400',
      gasSend: false,
      alertedAt: alertedAt.toISOString(),
      sendAt: new Date(alertedAt.getTime() + DAY * 1000).toISOString(),
    });
    assert.equal(stage?.problem, null);
    assert.equal(catalogue?.coming, null, 'no alert, nothing coming');
    assert.equal(catalogue?.problem, 'The top-up failed.');
    assert.deepEqual(catalogue?.lastTopUp?.days, 7);
    assert.equal(view.sentTodayPlur, '400');
    const estimate = autoTopUpMonthlyEstimatePlur([20, 18], POSTAGE);
    assert.equal(view.monthlyEstimatePlur, estimate);
    assert.equal(view.dailyCeilingPlur, (BigInt(estimate) / 2n).toString());
  });
});

describe("stamp auto top-up's settings", () => {
  it('saves the numbers with who saved them, audits it, and answers them', async () => {
    const { service, audit } = setup();
    const settings = { ...AUTO_TOPUP_DEFAULTS, marginPercent: 20, dailyCeilingPlur: '5000' };

    const view = await service.saveSettings(TEST_OPERATOR, settings);

    assert.deepEqual(view.settings, settings);
    assert.equal(view.settingsSavedBy, TEST_OPERATOR.username);
    assert.equal(view.settingsSavedAt, new Date(NOW).toISOString());
    assert.equal(view.dailyCeilingPlur, '5000', 'the ceiling saved is the one in force');
    const [entry] = audit.withAction('funding.auto_topup.settings');
    assert.equal(entry?.actor, TEST_OPERATOR);
    assert.deepEqual(entry?.details, { settings });
  });

  it('refuses numbers autoTopUpSettingsProblems refuses, and saves nothing', async () => {
    const { service, store } = setup();

    await assert.rejects(
      () => service.saveSettings(TEST_OPERATOR, { ...AUTO_TOPUP_DEFAULTS, topUpToDays: 7 }),
      RequestShapeError,
    );
    assert.equal(store.settingsRow, null);
  });
});

describe("stamp auto top-up's marks", () => {
  it("marks a stage's batch, the catalogue batch and an archive stamp, each with its node's label", async () => {
    const { service, manager, audit } = setup();
    manager!.inventoryAnswer = {
      ...stampInventory(),
      archiveBatches: [
        {
          ...fundingBatch({ batchId: BATCH_ARCHIVE, ttlSeconds: 90 * DAY }),
          nodeId: NODE_CATALOGUE,
          nodeLabel: 'Catalogue node',
          label: 'Archive 1',
          writable: true,
        },
      ],
    };

    const view = await service.setMarks(TEST_OPERATOR, true, [
      { nodeId: NODE_A, batchId: BATCH_STAGE },
      { nodeId: NODE_CATALOGUE, batchId: BATCH_CATALOGUE },
      { nodeId: NODE_CATALOGUE, batchId: BATCH_ARCHIVE },
    ]);

    assert.deepEqual(
      view.stamps.map((stamp) => [stamp.batchId, stamp.nodeLabel]),
      [
        [BATCH_STAGE, 'Main stage uploader'],
        [BATCH_CATALOGUE, 'Catalogue node'],
        [BATCH_ARCHIVE, 'Catalogue node'],
      ],
    );
    assert.equal(audit.withAction('funding.auto_topup.mark').length, 1);
  });

  it('refuses the whole request, and marks nothing, when one stamp cannot be marked', async () => {
    const { service, store, manager } = setup();
    const inventory = stampInventory();
    inventory.stages[0]!.nodes[2]!.batch = fundingBatch({ batchId: BATCH_RUNG, ttlSeconds: 0 });
    manager!.inventoryAnswer = inventory;

    for (const bad of [
      { nodeId: 'stage-9:nobody', batchId: BATCH_ARCHIVE },
      { nodeId: NODE_B, batchId: BATCH_CATALOGUE },
      { nodeId: NODE_RUNG, batchId: BATCH_RUNG },
    ]) {
      await assert.rejects(
        () => service.setMarks(TEST_OPERATOR, true, [{ nodeId: NODE_A, batchId: BATCH_STAGE }, bad]),
        (err: unknown) => err instanceof AutoTopUpNotMarkableError && err.problems.length === 1,
        JSON.stringify(bad),
      );
    }
    assert.equal(store.markRows.size, 0);
  });

  it('refuses a mark without a manager, or when it cannot be read', async () => {
    await assert.rejects(
      () => setup({ manager: null }).service.setMarks(TEST_OPERATOR, true, [{ nodeId: NODE_A, batchId: BATCH_STAGE }]),
      FundingRefusedError,
    );
    const down = setup();
    down.manager!.inventoryError = new Error('the manager is down');
    await assert.rejects(
      () => down.service.setMarks(TEST_OPERATOR, true, [{ nodeId: NODE_A, batchId: BATCH_STAGE }]),
      FundingManagerUnavailableError,
    );
  });

  it('takes the mark off with its alert and its warnings, without asking the manager', async () => {
    const { service, store, manager, audit } = setup();
    await service.setMarks(TEST_OPERATOR, true, [{ nodeId: NODE_A, batchId: BATCH_STAGE }]);
    await store.raiseWarning({ kind: 'stamp_expired', batchId: BATCH_STAGE }, 'It expired.', new Date(NOW));
    manager!.inventoryError = new Error('the manager is down');

    const view = await service.setMarks(TEST_OPERATOR, false, [{ nodeId: NODE_A, batchId: BATCH_STAGE }]);

    assert.deepEqual(view.stamps, []);
    assert.deepEqual(view.warnings, []);
    assert.deepEqual(audit.withAction('funding.auto_topup.unmark')[0]?.details, { batchIds: [BATCH_STAGE] });
  });
});

describe("stamp auto top-up's email list and pauses", () => {
  it('stores the addresses trimmed and in lower case, and refuses a list with a problem', async () => {
    const { service, store, audit } = setup();

    const view = await service.saveEmails(TEST_OPERATOR, ['  Ops@Example.org ', 'team@example.org']);

    assert.deepEqual(view.emails, ['ops@example.org', 'team@example.org']);
    assert.deepEqual(audit.withAction('funding.auto_topup.emails')[0]?.details, {
      emails: ['ops@example.org', 'team@example.org'],
    });
    await assert.rejects(() => service.saveEmails(TEST_OPERATOR, ['not an address']), RequestShapeError);
    await assert.rejects(
      () => service.saveEmails(TEST_OPERATOR, ['a@example.org', 'A@example.org']),
      RequestShapeError,
    );
    assert.deepEqual(store.emailList, ['ops@example.org', 'team@example.org']);
  });

  it('pauses a job with who and when, and resumes it', async () => {
    const { service, audit } = setup();

    const paused = await service.setJobPaused(TEST_OPERATOR, 'wallet', true);
    assert.deepEqual(paused.jobs[1], {
      job: 'wallet',
      paused: true,
      pausedBy: TEST_OPERATOR.username,
      pausedAt: new Date(NOW).toISOString(),
      lastRunAt: null,
      lastOk: null,
      lastOutcome: null,
    });

    const resumed = await service.setJobPaused(TEST_OPERATOR, 'wallet', false);
    assert.equal(resumed.jobs[1]?.paused, false);
    assert.equal(resumed.jobs[1]?.pausedBy, null);
    assert.deepEqual(
      audit.withAction('funding.auto_topup.job').map((entry) => entry.details),
      [
        { job: 'wallet', paused: true },
        { job: 'wallet', paused: false },
      ],
    );
  });
});
