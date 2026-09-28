/**
 * The `INGEST_*` keys a stream's stage replaced. An env file that still sets
 * them must start, so they are read only to be named at boot. Unit test.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RETIRED_ENV_KEYS, retiredEnvKeysSet } from '../../src/utils/retiredEnv.js';

describe('retiredEnvKeysSet', () => {
  it('names every retired key set to something, and none left empty', () => {
    const env = {
      INGEST_HOST: 'ingest.example.org',
      INGEST_SRT_PORT: '10061',
      INGEST_RTMP_PUBLIC: '',
      INGEST_SRT_PASSPHRASE: '   ',
      INGEST_KEY_VERIFIED: 'true',
      BEE_URL: 'http://bee.example.org:1633',
    };

    assert.deepEqual(retiredEnvKeysSet(env), ['INGEST_HOST', 'INGEST_SRT_PORT', 'INGEST_KEY_VERIFIED']);
    assert.deepEqual(retiredEnvKeysSet({}), []);
  });

  it('retires the six ingest keys the stage replaced, and nothing the admin still reads', () => {
    assert.deepEqual(
      [...RETIRED_ENV_KEYS],
      [
        'INGEST_HOST',
        'INGEST_SRT_PORT',
        'INGEST_RTMP_PORT',
        'INGEST_RTMP_PUBLIC',
        'INGEST_SRT_PASSPHRASE',
        'INGEST_KEY_VERIFIED',
      ],
    );
  });
});
