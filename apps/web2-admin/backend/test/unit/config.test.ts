/**
 * The env keys the catalogue stamp replaced, and `CATALOGUE_MOVE_ENABLED`. Unit test: the config module loaded afresh
 * in this process for each environment a test sets. `pnpm test`.
 *
 * `BEE_URL` and `POSTAGE_BATCH_ID` named the catalogue's node and batch until the manager's catalogue stamp did. The
 * config reads only the keys it names, so a host whose env file still sets them starts as one whose file does not,
 * and neither value reaches the config.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

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
