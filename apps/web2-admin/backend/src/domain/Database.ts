import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMigrations } from '@streaming-monorepo/db-migrate';
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
    await runMigrations({ pool: this.pool, migrationsDir: this.migrationsDir, logger });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
