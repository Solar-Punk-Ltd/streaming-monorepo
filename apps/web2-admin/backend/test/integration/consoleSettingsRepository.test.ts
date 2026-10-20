/**
 * ConsoleSettingsRepository against the real database (migration 021), and `/api/config` over the instance's HTTP.
 * Needs Postgres, like the rest of this suite. `DATABASE_URL` overrides the connection.
 *
 * What a fake cannot stand in for is the SQL: that migration 021 applied, that `console_settings` holds one row and
 * no other, that a name the console does not carry is not refused by the table, because the API reads an unknown one
 * as Swarm, and that the public config answers what is stored. Nothing in the admin writes the row any more, so each
 * test writes it with SQL.
 *
 * Every row it writes is in the suite's throwaway database, and it empties the table before each test.
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

async function storeLook(name: string, updatedBy: string): Promise<void> {
  await database.pool.query('INSERT INTO console_settings (default_theme, updated_by) VALUES ($1, $2)', [
    name,
    updatedBy,
  ]);
}

describe('migration 021, console_settings', () => {
  it('is applied', async () => {
    const ledger = await database.pool.query<{ name: string }>(
      "SELECT name FROM _migrations WHERE name = '021_console_settings.sql'",
    );

    assert.equal(ledger.rows.length, 1);
  });

  it('holds one row and no other', async () => {
    await storeLook('swarm', 'alice');

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

  it('takes a name the console does not carry, which the API reads as Swarm', async () => {
    await storeLook('retired-look', 'alice');

    assert.equal(await settings.defaultTheme(), 'retired-look');
  });
});

describe('ConsoleSettingsRepository', () => {
  it('reads null while there is no row', async () => {
    assert.equal(await settings.defaultTheme(), null);
  });
});

describe('GET /api/config', () => {
  it('answers Swarm with no row, and the stored look once there is one', async () => {
    assert.equal((await api<PublicConfig>('GET', '/api/config', { anonymous: true })).defaultTheme, 'swarm');

    await storeLook('web3privacy', 'alice');

    assert.equal((await api<PublicConfig>('GET', '/api/config', { anonymous: true })).defaultTheme, 'web3privacy');
  });
});
