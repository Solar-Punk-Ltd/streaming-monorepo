/**
 * STREAM_RESTART_WINDOW_MINUTES: how long after a stream ends it can still go live again on its key. 30 unless set, a
 * whole number from 0 to 10080 (a week), and any other value stops the start with a sentence that names the key.
 * Unit test: the config module loaded afresh in this process for each value. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

/** Everything the config requires, with values that stand for nothing. */
const REQUIRED = {
  DATABASE_URL: 'postgres://web2admin:web2admin@127.0.0.1:5433/web2admin',
  FEED_GATEWAY: 'fake',
  // Hardhat's first test account: public, and it signs nothing that matters.
  FEED_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  INTERNAL_API_TOKEN: 'restart-window-test-token-of-more-than-thirty-two-characters',
  INGEST_HOST: 'ingest.example.org',
};

const KEY = 'STREAM_RESTART_WINDOW_MINUTES';
let loads = 0;

/** The window a fresh copy of the config reads with `value` set, or unset when `value` is undefined. */
async function windowWith(value: string | undefined): Promise<unknown> {
  Object.assign(process.env, REQUIRED);
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  const module = (await import(`../../src/utils/config.js?restart-window-${++loads}`)) as {
    config: { streamRestartWindowMinutes: unknown };
  };
  return module.config.streamRestartWindowMinutes;
}

after(() => {
  delete process.env[KEY];
});

describe('STREAM_RESTART_WINDOW_MINUTES', () => {
  it('is 30 when the env file does not set it, or sets it empty', async () => {
    assert.equal(await windowWith(undefined), 30);
    assert.equal(await windowWith(''), 30);
  });

  it('takes 0, the key changing as soon as a stream ends, and a week, 10080', async () => {
    assert.equal(await windowWith('0'), 0);
    assert.equal(await windowWith('10080'), 10080);
    assert.equal(await windowWith('45'), 45);
    assert.equal(await windowWith(' 45 '), 45, 'surrounding spaces are trimmed');
  });

  it('stops the start on anything that is not a whole number of minutes from 0 to a week, naming the key', async () => {
    // Digits only: Number() alone would read the last four as 1000, 30, 30 and 30.
    for (const value of ['-1', '10081', '1.5', 'abc', '1e3', '0x1E', '30.0', '+30']) {
      await assert.rejects(windowWith(value), (error: unknown) => {
        assert.ok(error instanceof Error, value);
        assert.match(error.message, /STREAM_RESTART_WINDOW_MINUTES/, value);
        return true;
      });
    }
  });
});
