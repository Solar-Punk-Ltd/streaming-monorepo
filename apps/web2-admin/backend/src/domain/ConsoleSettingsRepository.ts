import type { AdminThemeName } from '@streaming-monorepo/web2-admin-common';
import type { Pool } from 'pg';

/** Where the console's settings for this host are kept: Postgres, or memory in the unit tests. */
export interface ConsoleSettingsStore {
  /** The default look as stored, which may name a look the console no longer carries, or null when none is set. */
  defaultTheme(): Promise<string | null>;
  /** Stores the default look, and answers the stored value it replaced, or null when none was set. */
  setDefaultTheme(name: AdminThemeName, updatedBy: string): Promise<string | null>;
}

/** The key of the advisory lock a save takes, by its name, as the funding locks are named. */
const CONSOLE_SETTINGS_LOCK_NAME = 'web2-admin:console-settings';

/** The console's one settings row, migration 021. */
export class ConsoleSettingsRepository implements ConsoleSettingsStore {
  constructor(private readonly pool: Pool) {}

  async defaultTheme(): Promise<string | null> {
    const result = await this.pool.query<{ default_theme: string }>('SELECT default_theme FROM console_settings');
    return result.rows[0]?.default_theme ?? null;
  }

  async setDefaultTheme(name: AdminThemeName, updatedBy: string): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Held until the transaction ends. Without it two saves at once can both read the row before either writes,
      // and the second's audit row then names a look it did not replace. A row lock cannot do this on the first
      // write, when there is no row yet to lock.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [CONSOLE_SETTINGS_LOCK_NAME]);
      const previous = await client.query<{ default_theme: string }>('SELECT default_theme FROM console_settings');
      await client.query(
        `INSERT INTO console_settings (id, default_theme, updated_by)
         VALUES (TRUE, $1, $2)
         ON CONFLICT (id) DO UPDATE
           SET default_theme = EXCLUDED.default_theme,
               updated_at = NOW(),
               updated_by = EXCLUDED.updated_by`,
        [name, updatedBy],
      );
      await client.query('COMMIT');
      return previous.rows[0]?.default_theme ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
