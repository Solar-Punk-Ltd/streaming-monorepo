import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { managedIngestLifecycleConfig } from '../../src/utils/managedIngestConfig.js';

describe('managed ingest lifecycle configuration', () => {
  it('is disabled by default', () => {
    assert.equal(managedIngestLifecycleConfig({}), null);
  });

  it('binds version one to one configured uploader', () => {
    assert.deepEqual(
      managedIngestLifecycleConfig({
        INGEST_MANAGED_LIFECYCLE_VERSION: '1',
        INGEST_MANAGED_UPLOADER_ID: ' srs-uploader-a ',
      }),
      { lifecycleVersion: 1, uploaderId: 'srs-uploader-a' },
    );
  });

  it('refuses unsupported versions and a missing uploader identity', () => {
    assert.throws(
      () =>
        managedIngestLifecycleConfig({
          INGEST_MANAGED_LIFECYCLE_VERSION: '2',
          INGEST_MANAGED_UPLOADER_ID: 'srs-uploader-a',
        }),
      /INGEST_MANAGED_LIFECYCLE_VERSION must be 1/,
    );
    assert.throws(
      () =>
        managedIngestLifecycleConfig({
          INGEST_MANAGED_LIFECYCLE_VERSION: '1',
        }),
      /INGEST_MANAGED_UPLOADER_ID is required/,
    );
  });
});
