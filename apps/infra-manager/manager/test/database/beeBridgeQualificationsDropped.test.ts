/**
 * Migration 053 drops `bee_bridge_qualifications`, the table migration 040 made for a chequebook transport the
 * manager no longer has, together with the index that belonged to it.
 *
 * `pnpm test:database` in manager/, or on its own with STACK_VERSIONS_TEST_PG_PORT set.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

const port = Number(process.env.STACK_VERSIONS_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 'stack_versions_test',
  connectionTimeoutMillis: 10000,
};

const DROPPED_TABLE = 'bee_bridge_qualifications';
const DROPPED_INDEX = 'bee_bridge_qualifications_one_pass';
const DROPPING_MIGRATION = '053';

describe(
  'the dropped bee bridge qualifications table, in isolated PostgreSQL',
  {
    skip: !Number.isInteger(port) || port < 1 || port > 65535,
    timeout: 60000,
  },
  () => {
    let admin: Pool;
    let pool: Pool;
    let schema: string;

    beforeEach(async () => {
      schema = `bridge_drop_${randomBytes(8).toString('hex')}`;
      admin = new pg.Pool(connection);
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({ ...connection, options: `-c search_path=${schema} -c statement_timeout=10000` });
    });

    afterEach(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });

    /** Applies, in name order, every migration whose name sorts from `from` up to but not including `before`. */
    async function migrate({ from = '000', before = '999' } = {}): Promise<void> {
      const directory = new URL('../../src/migrations/', import.meta.url);
      const names = (await readdir(directory))
        .filter((name) => name.endsWith('.sql') && name >= from && name < before)
        .sort();
      for (const name of names) await pool.query(await readFile(new URL(name, directory), 'utf8'));
    }

    async function relationExists(name: string): Promise<boolean> {
      const result = await pool.query<{ found: string | null }>('SELECT to_regclass($1)::text AS found', [name]);
      return result.rows[0].found !== null;
    }

    it('holds the table and its index before the dropping migration, so the check below can fail', async () => {
      await migrate({ before: DROPPING_MIGRATION });
      assert.equal(await relationExists(DROPPED_TABLE), true);
      assert.equal(await relationExists(DROPPED_INDEX), true);
    });

    it('leaves neither the table nor its index after every migration, its rows included', async () => {
      await migrate({ before: DROPPING_MIGRATION });
      await pool.query(
        `INSERT INTO ${DROPPED_TABLE} (image_id, engine_version, platform_os, platform_architecture, platform_variant,
           bridge_revision, harness_revision, outcome, evidence, evidence_digest, host_alias)
         VALUES ($1, '27.0.1', 'linux', 'amd64', '', $1, $1, 'passed', '{}', $1, 'stack-host')`,
        [`sha256:${'a'.repeat(64)}`],
      );
      await migrate({ from: DROPPING_MIGRATION });
      assert.equal(await relationExists(DROPPED_TABLE), false);
      assert.equal(await relationExists(DROPPED_INDEX), false);
    });
  },
);
