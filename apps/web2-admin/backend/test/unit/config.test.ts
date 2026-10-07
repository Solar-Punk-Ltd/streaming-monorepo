/**
 * The env keys the catalogue stamp replaced, `CATALOGUE_MOVE_ENABLED`, and the build the deploy builds in. Unit test:
 * the config module loaded afresh in this process for each environment a test sets. `pnpm test`.
 *
 * `BEE_URL` and `POSTAGE_BATCH_ID` named the catalogue's node and batch until the manager's catalogue stamp did. The
 * config reads only the keys it names, so a host whose env file still sets them starts as one whose file does not,
 * and neither value reaches the config.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { versionFrom } from '../../src/utils/buildVersion.js';

/** Everything the config requires, with values that stand for nothing. */
const REQUIRED = {
  DATABASE_URL: 'postgres://web2admin:web2admin@127.0.0.1:5433/web2admin',
  FEED_GATEWAY: 'bee',
  // Hardhat's first test account: public, and it signs nothing that matters.
  FEED_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  INTERNAL_API_TOKEN: 'config-test-token-of-more-than-thirty-two-characters',
  INGEST_HOST: 'ingest.example.org',
};

/** A fresh copy of the module each time: the query string makes it a module of its own. */
async function loadConfig(tag: string): Promise<Record<string, unknown>> {
  const module = (await import(`../../src/utils/config.js?${tag}`)) as { config: Record<string, unknown> };
  return module.config;
}

describe('the config', () => {
  it('starts with BEE_URL and POSTAGE_BATCH_ID still set, and reads neither', async () => {
    Object.assign(process.env, REQUIRED, {
      BEE_URL: 'http://192.0.2.20:1633',
      POSTAGE_BATCH_ID: '0'.repeat(64),
    });

    const config = await loadConfig('stale-keys');

    const text = JSON.stringify(config);
    assert.equal(text.includes('192.0.2.20'), false);
    assert.equal(text.includes('0'.repeat(64)), false);
    assert.equal('beeUrl' in config, false);
    assert.equal('postageBatchId' in config, false);
  });

  it('starts without them', async () => {
    Object.assign(process.env, REQUIRED);
    delete process.env.BEE_URL;
    delete process.env.POSTAGE_BATCH_ID;

    const config = await loadConfig('without-keys');

    assert.equal(config.feedGateway, 'bee');
  });
});

describe('CATALOGUE_MOVE_ENABLED', () => {
  it('is off when unset: the move is tried on a real node before it is turned on', async () => {
    Object.assign(process.env, REQUIRED);
    delete process.env.CATALOGUE_MOVE_ENABLED;

    const config = await loadConfig('move-unset');

    assert.equal(config.catalogueMoveEnabled, false);
  });

  it('is on for true or 1, and off for false or 0', async () => {
    const answers: Record<string, boolean> = { true: true, '1': true, TRUE: true, false: false, '0': false };
    for (const [value, expected] of Object.entries(answers)) {
      Object.assign(process.env, REQUIRED, { CATALOGUE_MOVE_ENABLED: value });
      const config = await loadConfig(`move-${value}`);
      assert.equal(config.catalogueMoveEnabled, expected, value);
    }
    delete process.env.CATALOGUE_MOVE_ENABLED;
  });

  it('refuses any other value rather than guess', async () => {
    Object.assign(process.env, REQUIRED, { CATALOGUE_MOVE_ENABLED: 'yes please' });
    await assert.rejects(loadConfig('move-bad'), /CATALOGUE_MOVE_ENABLED must be true or false/);
    delete process.env.CATALOGUE_MOVE_ENABLED;
  });
});

describe('FEED_PRIVATE_KEY', () => {
  /**
   * The env sample ships it empty, because a key printed in a public file signs a catalogue anyone can write. So the
   * API does not start on a copy of the sample until the operator names a key of their own.
   */
  it('refuses to start without one', async () => {
    for (const [tag, value] of [
      ['empty', ''],
      ['blank', '   '],
    ]) {
      Object.assign(process.env, REQUIRED, { FEED_PRIVATE_KEY: value });
      await assert.rejects(loadConfig(`feed-key-${tag}`), /FEED_PRIVATE_KEY/, tag);
    }
    Object.assign(process.env, REQUIRED);
  });

  it('is shipped empty in the env sample', () => {
    const sample = readFileSync(new URL('../../.env.sample', import.meta.url), 'utf8');
    assert.match(sample, /^FEED_PRIVATE_KEY=$/m);
  });
});

/**
 * The build the deploy built into the image. Whatever a deploy could not have built in is null, so the console says
 * it runs a development build rather than name one nobody made.
 */
describe('WEB2_ADMIN_VERSION and WEB2_ADMIN_COMMIT', () => {
  const COMMIT = '0123456789abcdef0123456789abcdef01234567';

  it('are both null when neither is set, as outside a deploy', () => {
    assert.deepEqual(versionFrom({}), { label: null, commit: null });
  });

  it('keep every label tools/release/version.mjs names a build with', () => {
    for (const label of [
      'QA-build-2026-10-07',
      'QA-build-2026-10-07+3',
      'QA-build-2026-10-07+3-dirty',
      'release/2026.10_rc1',
      '0123456789',
      '012345678-dirty',
      `${'a'.repeat(80)}+12345-dirty`,
    ]) {
      assert.deepEqual(versionFrom({ WEB2_ADMIN_VERSION: label, WEB2_ADMIN_COMMIT: COMMIT }), {
        label,
        commit: COMMIT,
      });
    }
  });

  it('make a label null that holds anything else, or nothing, or more than 96 characters', () => {
    for (const label of [
      '',
      ' QA-build',
      'QA build',
      "QA'build",
      'QA"build',
      'QA$(id)',
      'QA;build',
      'QA\nbuild',
      'QA-büild',
      'QA<b>',
      'a'.repeat(97),
    ]) {
      assert.equal(versionFrom({ WEB2_ADMIN_VERSION: label, WEB2_ADMIN_COMMIT: COMMIT }).label, null, label);
    }
  });

  it('make a commit null that is not 40 lowercase hex characters', () => {
    for (const commit of [
      '',
      COMMIT.toUpperCase(),
      COMMIT.slice(0, 39),
      `${COMMIT}0`,
      COMMIT.slice(0, 9),
      `${COMMIT}-dirty`,
      ` ${COMMIT}`,
      'g'.repeat(40),
    ]) {
      assert.equal(versionFrom({ WEB2_ADMIN_VERSION: 'QA-build', WEB2_ADMIN_COMMIT: commit }).commit, null, commit);
    }
  });

  it('keep each value on its own: a bad commit leaves the label, and a bad label the commit', () => {
    assert.deepEqual(versionFrom({ WEB2_ADMIN_VERSION: 'QA-build', WEB2_ADMIN_COMMIT: 'unknown' }), {
      label: 'QA-build',
      commit: null,
    });
    assert.deepEqual(versionFrom({ WEB2_ADMIN_VERSION: 'QA build', WEB2_ADMIN_COMMIT: COMMIT }), {
      label: null,
      commit: COMMIT,
    });
  });

  it('are read once, when the config loads', async () => {
    Object.assign(process.env, REQUIRED, { WEB2_ADMIN_VERSION: 'QA-build+1', WEB2_ADMIN_COMMIT: COMMIT });

    const config = await loadConfig('version-set');
    process.env.WEB2_ADMIN_VERSION = 'QA-build+2';

    assert.deepEqual(config.version, { label: 'QA-build+1', commit: COMMIT });
    delete process.env.WEB2_ADMIN_VERSION;
    delete process.env.WEB2_ADMIN_COMMIT;
  });

  it('load as nulls when unset or malformed, rather than stop the API from starting', async () => {
    Object.assign(process.env, REQUIRED);
    delete process.env.WEB2_ADMIN_VERSION;
    delete process.env.WEB2_ADMIN_COMMIT;
    assert.deepEqual((await loadConfig('version-unset')).version, { label: null, commit: null });

    Object.assign(process.env, REQUIRED, { WEB2_ADMIN_VERSION: 'QA build', WEB2_ADMIN_COMMIT: 'unknown' });
    assert.deepEqual((await loadConfig('version-malformed')).version, { label: null, commit: null });
    delete process.env.WEB2_ADMIN_VERSION;
    delete process.env.WEB2_ADMIN_COMMIT;
  });
});
