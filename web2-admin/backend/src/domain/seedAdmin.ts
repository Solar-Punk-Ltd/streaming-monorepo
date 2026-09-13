import { Logger } from './Logger.js';
import { hashPassword } from './password.js';
import { UserRepository } from './UserRepository.js';

const logger = Logger.getInstance();

export interface SeedAdminOptions {
  username: string;
  password: string;
}

/**
 * Creates the first user, and only while there is none: the console has to be
 * reachable after a fresh `pnpm database:start`, and nothing else in
 * checkpoint 2 can create a user. Once anyone exists this is a no-op, so
 * changing SEED_ADMIN_PASSWORD later does not reset anybody's password.
 */
export async function seedAdminUser(
  users: UserRepository,
  options: SeedAdminOptions,
): Promise<void> {
  if ((await users.count()) > 0) {
    await warnAboutDefaultPassword(users, options.username);
    return;
  }

  const user = await users.insert(
    options.username,
    await hashPassword(options.password),
  );
  logger.warn(
    `[Boot] Created seed admin user "${user.username}" with the configured SEED_ADMIN_PASSWORD. Change it in the UI.`,
  );
}

async function warnAboutDefaultPassword(
  users: UserRepository,
  username: string,
): Promise<void> {
  const existing = await users.findByUsername(username);
  if (existing && existing.password_changed_at === null) {
    logger.warn(
      `[Boot] Seed admin user "${username}" still has its seeded password. Change it in the UI.`,
    );
  }
}
