import { type AdminThemeName, DEFAULT_ADMIN_THEME, isAdminThemeName } from '@streaming-monorepo/web2-admin-common';

import type { OperatorActor } from './actor.js';
import { type AuditLog, recordAudit } from './AuditLog.js';
import type { ConsoleSettingsStore } from './ConsoleSettingsRepository.js';
import { Logger } from './Logger.js';

const logger = Logger.getInstance();

/** A stored name the console no longer carries, or none at all, is worn as Default. */
function wornLook(stored: string | null): AdminThemeName {
  return isAdminThemeName(stored) ? stored : DEFAULT_ADMIN_THEME;
}

/** The console's settings for this host: the look it starts in, read by anyone and set by an admin. */
export class ConsoleSettingsService {
  constructor(
    private readonly store: ConsoleSettingsStore,
    private readonly audit: AuditLog,
  ) {}

  /**
   * A read that fails answers Default rather than failing `/api/config`, which also carries the feed and the
   * viewer link the login page and the stream pages need, and which never touched the database before.
   */
  async defaultTheme(): Promise<AdminThemeName> {
    try {
      return wornLook(await this.store.defaultTheme());
    } catch (err) {
      logger.warn(`[Console] could not read this host's default look, answering ${DEFAULT_ADMIN_THEME}:`, err);
      return DEFAULT_ADMIN_THEME;
    }
  }

  /** The route admits admins alone, so this trusts its caller to be one. */
  async setDefaultTheme(actor: OperatorActor, name: AdminThemeName): Promise<AdminThemeName> {
    const from = wornLook(await this.store.setDefaultTheme(name, actor.username));
    logger.info(`[Console] ${actor.username} set this host's default look: ${from} → ${name}`);
    await recordAudit(this.audit, { actor, action: 'console.theme.set', details: { from, to: name } });
    return name;
  }
}
