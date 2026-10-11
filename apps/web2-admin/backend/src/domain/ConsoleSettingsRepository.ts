import type { AdminThemeName } from '@streaming-monorepo/web2-admin-common';
import type { Pool } from 'pg';

/** Where the console's settings for this host are kept: Postgres, or memory in the unit tests. */
export interface ConsoleSettingsStore {
  /** The default look as stored, which may name a look the console no longer carries, or null when none is set. */
  defaultTheme(): Promise<string | null>;
  /** Stores the default look, and answers the stored value it replaced, or null when none was set. */
  setDefaultTheme(name: AdminThemeName, updatedBy: string): Promise<string | null>;
}

/** The console's one settings row, migration 021. */
export class ConsoleSettingsRepository implements ConsoleSettingsStore {
  constructor(private readonly pool: Pool) {}

  async defaultTheme(): Promise<string | null> {
    const result = await this.pool.query<{ default_theme: string }>('SELECT default_theme FROM console_settings');
    return result.rows[0]?.default_theme ?? null;
  }

  async setDefaultTheme(name: AdminThemeName, updatedBy: string): Promise<string | null> {
    // The CTE reads the row as it stood when the statement began, so one statement both writes the new value and
    // answers the old one for the audit row.
    const result = await this.pool.query<{ previous: string | null }>(
      `WITH previous AS (SELECT default_theme FROM console_settings)
       INSERT INTO console_settings (id, default_theme, updated_by)
       VALUES (TRUE, $1, $2)
       ON CONFLICT (id) DO UPDATE
         SET default_theme = EXCLUDED.default_theme,
             updated_at = NOW(),
             updated_by = EXCLUDED.updated_by
       RETURNING (SELECT default_theme FROM previous) AS previous`,
      [name, updatedBy],
    );
    return result.rows[0]?.previous ?? null;
  }
}
