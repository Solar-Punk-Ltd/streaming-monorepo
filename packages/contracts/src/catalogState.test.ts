import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CATALOG_STATE_LIVE, CATALOG_STATE_SCHEDULED, CATALOG_STATE_VOD, CATALOG_STATES } from './catalogState.js';

describe('the state a catalog entry is written with', () => {
  it('is live, a recording or scheduled', () => {
    assert.deepEqual(CATALOG_STATES, ['live', 'vod', 'scheduled']);
    assert.equal(CATALOG_STATE_LIVE, 'live');
    assert.equal(CATALOG_STATE_VOD, 'vod');
    assert.equal(CATALOG_STATE_SCHEDULED, 'scheduled');
  });
});
