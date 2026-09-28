/**
 * The manager's stage routes and the console's reads of them against the RUNNING backend: the suite's own instance,
 * wired by `src/index.ts` and `src/api/server.ts`, against a throwaway database (see instance.ts).
 *
 * What only a whole backend shows: that the manager's routes answer on the registrar token alone, with none of the
 * headers a browser sends, ahead of the cross-site check; that what the manager pushes comes back out of
 * `GET /api/stages` and `GET /api/catalogue-stamp` after a round trip through Postgres; and that neither answer
 * carries the passphrase, the token hash or the Bee API address. The ordering and audit rules are the unit suite's
 * and `stageRepository.test.ts`'s.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { CatalogueStampResponse, StageListResponse } from '@streaming-monorepo/web2-admin-common';

import {
  catalogueStampRecord,
  SRT_PASSPHRASE,
  STAGE_ID,
  stageRecord,
  TOKEN_SHA256,
} from '../unit/support/stageFakes.js';

import { internalCall, login, raw, releaseStack, requireStack } from './helpers.js';

const stagePath = `/api/internal/stages/${STAGE_ID}`;

/** A DELETE body: the moment the manager saw the deployment, or the designation, gone. */
const GONE = { observedAt: '2026-09-28T10:05:00.000Z' };

before(async () => {
  await requireStack();
  await login();
});

after(async () => {
  await releaseStack();
});

describe('the manager’s stage routes', () => {
  it('refuse every call without the registrar token, and a console session in its place', async () => {
    const calls: [string, string, unknown][] = [
      ['PUT', stagePath, stageRecord()],
      ['DELETE', stagePath, GONE],
      ['PUT', '/api/internal/catalogue-stamp', catalogueStampRecord()],
      ['DELETE', '/api/internal/catalogue-stamp', GONE],
    ];
    for (const [method, path, body] of calls) {
      const anonymous = await raw(method, path, { body, anonymous: true, crossSiteHeader: false });
      assert.equal(anonymous.status, 401, `${method} ${path}`);
      const session = await raw(method, path, { body });
      assert.equal(session.status, 401, `${method} ${path} with a console session`);
    }
  });

  it('register a stage the console then lists, without its secrets', async () => {
    const stored = await raw('PUT', stagePath, { ...internalCall(), body: stageRecord() });
    assert.equal(stored.status, 200, stored.text);
    assert.deepEqual(stored.body, { stored: true });

    const listed = await raw('GET', '/api/stages');
    assert.equal(listed.status, 200);
    assert.equal(listed.text.includes(SRT_PASSPHRASE), false, 'the passphrase reached the console');
    assert.equal(listed.text.includes(TOKEN_SHA256), false, 'the token hash reached the console');
    const [stage, ...rest] = (listed.body as StageListResponse).stages;
    assert.equal(rest.length, 0);
    assert.equal(stage?.stageId, STAGE_ID);
    assert.equal(stage?.supported, true);
    assert.equal(stage?.ingest.hasSrtPassphrase, true);
    assert.equal(stage?.observedAt, stageRecord().observedAt);
    assert.equal(stage?.retiredAt, null);

    assert.equal((await raw('GET', '/api/stages', { anonymous: true })).status, 401);
  });

  it('refuse a retirement without the moment the manager saw the stage gone', async () => {
    const answer = await raw('DELETE', stagePath, internalCall());
    assert.equal(answer.status, 400);
  });

  it('retire it as of that moment, which the console still lists', async () => {
    const retired = await raw('DELETE', stagePath, { ...internalCall(), body: GONE });
    assert.deepEqual(retired.body, { retired: true });

    const [stage] = ((await raw('GET', '/api/stages')).body as StageListResponse).stages;
    assert.equal(stage?.stageId, STAGE_ID);
    assert.equal(stage?.retiredAt, GONE.observedAt);
  });

  it('set and clear the catalogue stamp, which the console reads without the Bee API address', async () => {
    // The instance runs the in-memory gateway, which writes with no catalogue stamp, so nothing is refused.
    const unset = { catalogueStamp: null, catalogueWrite: { batch: null, refusal: null, moveWaitingTo: null } };
    assert.deepEqual((await raw('GET', '/api/catalogue-stamp')).body, unset);

    const stored = await raw('PUT', '/api/internal/catalogue-stamp', {
      ...internalCall(),
      body: catalogueStampRecord(),
    });
    assert.deepEqual(stored.body, { stored: true });

    const read = await raw('GET', '/api/catalogue-stamp');
    assert.equal((read.body as CatalogueStampResponse).catalogueStamp?.batchId, catalogueStampRecord().batchId);
    assert.equal((read.body as CatalogueStampResponse).catalogueWrite.batch?.batchId, catalogueStampRecord().batchId);
    assert.equal(read.text.includes('192.0.2.10'), false);

    const cleared = await raw('DELETE', '/api/internal/catalogue-stamp', { ...internalCall(), body: GONE });
    assert.deepEqual(cleared.body, { cleared: true });
    assert.deepEqual((await raw('GET', '/api/catalogue-stamp')).body, unset);
  });
});
