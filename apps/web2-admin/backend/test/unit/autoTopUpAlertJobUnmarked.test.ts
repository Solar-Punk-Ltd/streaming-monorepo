/**
 * The stamps not on auto top-up in the alert job's run: its pass runs after the alert job's own work, through the same
 * notifier, and adds its sentence to the run's outcome without ever failing the run. Unit test over stores in memory
 * and a notifier whose people tick topics. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { SECONDS_PER_DAY } from '@streaming-monorepo/web2-admin-common';

import { AutoTopUpAlertJob } from '../../src/domain/funding/AutoTopUpAlertJob.js';
import { UnmarkedStampPass } from '../../src/domain/funding/UnmarkedStampPass.js';

import { InMemoryStampAutoTopUpStore } from './support/autoTopUpFakes.js';
import {
  InMemoryUnmarkedStampStore,
  PeopleNotifier,
  WATCH_T0,
  watchContext,
  watchInventory,
} from './support/unmarkedStampFakes.js';

const DAY = SECONDS_PER_DAY;
const silent = { info: () => undefined, warn: () => undefined };

let autoTopUpStore: InMemoryStampAutoTopUpStore;
let unmarkedStore: InMemoryUnmarkedStampStore;
let notifier: PeopleNotifier;

beforeEach(() => {
  autoTopUpStore = new InMemoryStampAutoTopUpStore();
  unmarkedStore = new InMemoryUnmarkedStampStore();
  notifier = new PeopleNotifier();
});

function alertJob(withPass: boolean): AutoTopUpAlertJob {
  const pass = withPass ? new UnmarkedStampPass({ store: unmarkedStore, logger: silent }) : null;
  return new AutoTopUpAlertJob(autoTopUpStore, notifier, silent, pass);
}

describe('the alert job and the stamps not on auto top-up', () => {
  it("runs their pass after its own work, through its notifier, and adds the pass's sentence to its outcome without failing", async () => {
    const low = watchContext(WATCH_T0, watchInventory({ stage: { ttlSeconds: 5 * DAY } }));
    const own = await alertJob(false).run(low);
    assert.equal((await unmarkedStore.rows()).length, 0, 'no pass, no list');

    notifier.failing = true;
    const result = await alertJob(true).run(low);
    assert.equal(result.ok, true, 'a notice of theirs that no destination took fails nothing');
    assert.equal(
      result.outcome,
      `${own.outcome} Stamps not on auto top-up: 1 under "Top up when under". No destination took their notice, ` +
        'since 1 destination could not take it: it goes again at the next run.',
    );
    assert.equal((await unmarkedStore.rows()).length, 1);
  });

  it('keeps its own outcome with nothing listed', async () => {
    const healthy = watchContext(WATCH_T0, watchInventory());
    const own = await alertJob(false).run(healthy);
    assert.deepEqual(await alertJob(true).run(healthy), own);
    assert.equal(notifier.notifies, 0);
  });
});
