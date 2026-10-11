/**
 * ConsoleSettingsRepository against the real database (migration 021), and `/api/config` over the instance's HTTP.
 * Needs Postgres, like the rest of this suite; `DATABASE_URL` overrides the connection.
 *
 * What a fake cannot stand in for is the SQL: that migration 021 applied; that `console_settings` holds one row and
 * no other; that a write answers the value it replaced, null on the first; that a name the console does not carry is
 * not refused by the table, because the API checks names and reads an unknown one as Default; and that the public
 * config answers what is stored.
 *
 * Every row it writes is in the suite's throwaway database; it empties the table before each test.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { PublicConfig } from '@streaming-monorepo/web2-admin-common';

import { ConsoleSettingsRepository } from '../../src/domain/ConsoleSettingsRepository.js';
import { Database } from '../../src/domain/Database.js';

import { api, releaseStack, requireStack, stack } from './helpers.js';

let database: Database;
let settings: ConsoleSettingsRepository;

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  settings = new ConsoleSettingsRepository(database.pool);
});

after(async () => {
  if (!database) {
    await releaseStack();
    return;
  }
  await database.close();
  await releaseStack();
});

beforeEach(async () => {
  await database.pool.query('DELETE FROM console_settings');
});

describe('migration 021, console_settings', () => {
  it('is applied', async () => {
    const ledger = await database.pool.query<{ name: string }>(
      "SELECT name FROM _migrations WHERE name = '021_console_settings.sql'",
    );

    assert.equal(ledger.rows.length, 1);
  });

  it('holds one row and no other', async () => {
    await settings.setDefaultTheme('swarm', 'alice');

    await assert.rejects(
      database.pool.query("INSERT INTO console_settings (default_theme, updated_by) VALUES ('default', 'bob')"),
      { code: '23505' },
    );
    await assert.rejects(
      database.pool.query(
        "INSERT INTO console_settings (id, default_theme, updated_by) VALUES (FALSE, 'default', 'bob')",
      ),
      { code: '23514' },
    );
  });

  it('takes a name the console does not carry, which the API reads as Default', async () => {
    await database.pool.query(
      "INSERT INTO console_settings (default_theme, updated_by) VALUES ('retired-look', 'alice')",
    );

    assert.equal(await settings.defaultTheme(), 'retired-look');
  });
});

describe('ConsoleSettingsRepository', () => {
  it('reads null before any admin set a look', async () => {
    assert.equal(await settings.defaultTheme(), null);
  });

  it('stores a look, answers the one it replaced, and records who set it', async () => {
    assert.equal(await settings.setDefaultTheme('swarm', 'alice'), null);
    assert.equal(await settings.setDefaultTheme('web3privacy', 'bob'), 'swarm');

    assert.equal(await settings.defaultTheme(), 'web3privacy');
    const row = await database.pool.query<{ updated_by: string; count: number }>(
      'SELECT updated_by, (SELECT COUNT(*)::int FROM console_settings) AS count FROM console_settings',
    );
    assert.deepEqual(row.rows[0], { updated_by: 'bob', count: 1 });
  });
});

describe('GET /api/config', () => {
  it('answers Default with no row, and the stored look once there is one', async () => {
    assert.equal((await api<PublicConfig>('GET', '/api/config', { anonymous: true })).defaultTheme, 'default');

    await settings.setDefaultTheme('swarm', 'alice');

    assert.equal((await api<PublicConfig>('GET', '/api/config', { anonymous: true })).defaultTheme, 'swarm');
  });
});
