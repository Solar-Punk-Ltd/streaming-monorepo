import type { AdminThemeName } from '@streaming-monorepo/web2-admin-common';

import type { ConsoleSettingsStore } from '../../../src/domain/ConsoleSettingsRepository.js';

/** The console's settings row in memory: `stored` is the column as written, null while there is no row. */
export class InMemoryConsoleSettingsStore implements ConsoleSettingsStore {
  stored: string | null = null;
  updatedBy: string | null = null;

  async defaultTheme(): Promise<string | null> {
    return this.stored;
  }

  async setDefaultTheme(name: AdminThemeName, updatedBy: string): Promise<string | null> {
    const previous = this.stored;
    this.stored = name;
    this.updatedBy = updatedBy;
    return previous;
  }
}
