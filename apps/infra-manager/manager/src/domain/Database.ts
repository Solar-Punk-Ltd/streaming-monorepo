import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIGRATION_LOCK_KEY, runMigrations } from '@streaming-monorepo/db-migrate';
import pg from 'pg';
const { Pool } = pg;
type Pool = pg.Pool;

import { Logger } from './Logger.js';

export { MIGRATION_LOCK_KEY };

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', 'migrations');

const logger = Logger.getInstance();

export class Database {
  public readonly pool: Pool;

  constructor(
    connectionString: string,
    private readonly migrationsDir = MIGRATIONS_DIR,
  ) {
    this.pool = new Pool({ connectionString, max: 10 });
    // node-postgres reports an idle connection's failure as an 'error' event on
    // the pool, and an emitter with no listener for it throws what it was given
    // where nothing is waiting to catch it. Postgres restarting under a live
    // pool is ordinary, so it must cost the connection and not the process.
    this.pool.on('error', (error: Error) => {
      logger.error(`[Database] A pooled connection failed while idle. Discarding it. ${error.message}`);
    });
  }

  async migrate(): Promise<void> {
    await runMigrations({ pool: this.pool, migrationsDir: this.migrationsDir, logger });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
