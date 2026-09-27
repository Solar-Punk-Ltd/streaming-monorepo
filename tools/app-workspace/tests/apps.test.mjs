import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { APP_SETTINGS } from '../apps.mjs';

describe('the table of apps', () => {
  it('names the three apps, and the manager alone injects its workspace packages', () => {
    assert.deepEqual(APP_SETTINGS, {
      'apps/hls-stream': { injectWorkspacePackages: false },
      'apps/infra-manager': { injectWorkspacePackages: true },
      'apps/web2-admin': { injectWorkspacePackages: false },
    });
  });

  it('cannot be changed by the code that reads it', () => {
    assert.equal(Object.isFrozen(APP_SETTINGS), true);
    assert.equal(Object.values(APP_SETTINGS).every(Object.isFrozen), true);
  });
});
