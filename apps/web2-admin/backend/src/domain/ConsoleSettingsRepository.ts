import type { Pool } from 'pg';

/** Where the console's settings for this host are kept: Postgres, or memory in the unit tests. */
export interface ConsoleSettingsStore {
  /** The default look as stored, which may name a look the console no longer carries, or null when none is set. */
  defaultTheme(): Promise<string | null>;
}

/** The console's one settings row, migration 021. */
export class ConsoleSettingsRepository implements ConsoleSettingsStore {
  constructor(private readonly pool: Pool) {}

  async defaultTheme(): Promise<string | null> {
    const result = await this.pool.query<{ default_theme: string }>('SELECT default_theme FROM console_settings');
    return result.rows[0]?.default_theme ?? null;
  }
}
