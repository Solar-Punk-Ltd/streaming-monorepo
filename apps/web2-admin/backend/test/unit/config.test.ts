/**
 * The env keys the catalogue stamp replaced. Unit test: the config module loaded twice in this process, under two
 * environments. `pnpm test`.
 *
 * `BEE_URL` and `POSTAGE_BATCH_ID` named the catalogue's node and batch until the manager's catalogue stamp did. The
 * config reads only the keys it names, so a host whose env file still sets them starts as one whose file does not,
 * and neither value reaches the config.
 */
import assert from 'node:assert/strict';
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
