/**
 * What the stage records read from the database: the manager's own id,
 * migration 045, and a deployment's public ingest address, migration 046,
 * against a real PostgreSQL.
 *
 * `pnpm test:database` in manager/, or on its own with DEPLOYMENT_SETTINGS_TEST_PG_PORT set.
 *
 * What only the database can show: that the manager has exactly one id, a
 * UUID the migration generated, that reading it twice gives the same one, and
 * that the ingest address rides on every profile read, is saved on its own and
 * refused empty even from a write that skipped the service.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { UUID_PATTERN } from '@streaming-monorepo/contracts';

import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { readManagerId } from '../../src/domain/stages/managerIdentity.js';

const port = Number(process.env.DEPLOYMENT_SETTINGS_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 'deployment_settings_test',
  connectionTimeoutMillis: 10000,
};

describe(
  'the columns stage records read, in isolated PostgreSQL',
  {
    skip: !Number.isInteger(port) || port < 1 || port > 65535,
  },
  () => {
    let admin: Pool;
    let pool: Pool;
    let schema: string;
    let profiles: ProfileRepository;

    async function migrate(target: Pool): Promise<void> {
      const directory = new URL('../../src/migrations/', import.meta.url);
      const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
      for (const name of names) {
        await target.query(await readFile(new URL(name, directory), 'utf8'));
      }
    }

    beforeEach(async () => {
      schema = `stage_columns_${randomBytes(8).toString('hex')}`;
      admin = new pg.Pool(connection);
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({ ...connection, max: 4, options: `-c search_path=${schema}` });
      profiles = new ProfileRepository(pool);
      await migrate(pool);
    });

    afterEach(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });

    async function insertStage(name: string, slot: number): Promise<void> {
      await pool.query(
        `INSERT INTO profiles (name, port_slot, kind, stack_version_id)
         SELECT $1, $2, 'streamer', id FROM stack_versions ORDER BY id LIMIT 1`,
        [name, slot],
      );
    }

    it('holds one manager id, a UUID, the same on every read', async () => {
      const first = await readManagerId(pool);
      assert.match(first, UUID_PATTERN);
      assert.equal(await readManagerId(pool), first);
      const rows = await pool.query('SELECT count(*)::int AS n FROM manager_identity');
      assert.equal(rows.rows[0].n, 1);
      await assert.rejects(pool.query('INSERT INTO manager_identity (singleton) VALUES (FALSE)'));
      await assert.rejects(pool.query('INSERT INTO manager_identity DEFAULT VALUES'));
    });

    it('reads the ingest address on every profile, null until one is saved', async () => {
      await insertStage('stage-one', 1);
      assert.equal((await profiles.findByName('stage-one'))?.ingest_host, null);

      const saved = await profiles.updateIngestHost('stage-one', 'ingest.example.org');
      assert.equal(saved?.ingest_host, 'ingest.example.org');
      assert.equal((await profiles.findByName('stage-one'))?.ingest_host, 'ingest.example.org');
      assert.equal((await profiles.list()).find((row) => row.name === 'stage-one')?.ingest_host, 'ingest.example.org');

      assert.equal((await profiles.updateIngestHost('stage-one', null))?.ingest_host, null);
      assert.equal(await profiles.updateIngestHost('nobody', 'ingest.example.org'), null);
    });

    it('refuses an empty or overlong address even from a write that skips the service', async () => {
      await insertStage('raw-stage', 7);
      await assert.rejects(pool.query(`UPDATE profiles SET ingest_host = '' WHERE name = 'raw-stage'`));
      await assert.rejects(pool.query(`UPDATE profiles SET ingest_host = repeat('a', 254) WHERE name = 'raw-stage'`));
    });
  },
);
