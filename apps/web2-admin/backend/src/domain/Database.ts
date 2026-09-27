import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
const { Pool } = pg;
type Pool = pg.Pool;

import { Logger } from './Logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', 'migrations');

const logger = Logger.getInstance();

// node-postgres hands BIGINT back as a string, because int8 does not fit in a
// double. The only int8 this schema reads is a feed index (and feed_writes.id,
// which nothing reads): sequence numbers of catalog writes, nowhere near 2^53.
// Parsing them as numbers keeps `publishedFeedIndex` a number on the wire, as
// the API contract declares.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export class Database {
  public readonly pool: Pool;

  constructor(
    connectionString: string,
    private readonly migrationsDir = MIGRATIONS_DIR,
  ) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = readdirSync(this.migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const seen = await this.pool.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
      if (seen.rowCount && seen.rowCount > 0) continue;

      const sql = readFileSync(join(this.migrationsDir, file), 'utf8');
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info(`[Database] Applied migration: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
