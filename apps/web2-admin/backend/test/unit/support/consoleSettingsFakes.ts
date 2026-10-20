import type { ConsoleSettingsStore } from '../../../src/domain/ConsoleSettingsRepository.js';

/** The console's settings row in memory: `stored` is the column as written, null while there is no row. */
export class InMemoryConsoleSettingsStore implements ConsoleSettingsStore {
  stored: string | null = null;
  /** Makes every read throw, as a database that cannot be reached does. */
  failReads = false;

  async defaultTheme(): Promise<string | null> {
    if (this.failReads) throw new Error('database unreachable');
    return this.stored;
  }
}
