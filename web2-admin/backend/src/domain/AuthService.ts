import type { UserRow } from '../types/index.js';

import {
  InvalidCredentialsError,
  InvalidPasswordError,
} from './errors/index.js';
import { Logger } from './Logger.js';
import { LoginRateLimiter } from './LoginRateLimiter.js';
import { hashPassword, verifyPassword } from './password.js';
import { SessionRepository } from './SessionRepository.js';
import {
  createSessionToken,
  hashSessionToken,
  isSessionActive,
  sessionExpiresAt,
} from './sessionToken.js';
import { UserRepository } from './UserRepository.js';

const logger = Logger.getInstance();

export interface LoginResult {
  user: UserRow;
  /** The cookie value. Only its hash reaches the database. */
  token: string;
  expiresAt: Date;
}

export interface AuthenticatedSession {
  user: UserRow;
  tokenHash: string;
}

export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly rateLimiter: LoginRateLimiter,
    private readonly sessionTtlHours: number,
  ) {}

  async login(username: string, password: string): Promise<LoginResult> {
    this.rateLimiter.check(username);

    const user = await this.users.findByUsername(username);
    // A username that does not exist gets no bucket: there is no password
    // behind it to guess, and remembering it is how an attacker would grow
    // the throttle's memory for free. It also means the response time differs
    // from a wrong password — not worth a dummy hash here, as usernames are
    // not a secret in a single-operator console.
    if (!user) throw new InvalidCredentialsError(username);

    if (!(await verifyPassword(password, user.password_hash))) {
      this.rateLimiter.recordFailure(username);
      throw new InvalidCredentialsError(username);
    }
    this.rateLimiter.clear(username);

    const token = createSessionToken();
    const expiresAt = sessionExpiresAt(new Date(), this.sessionTtlHours);
    await this.sessions.insert(user.id, hashSessionToken(token), expiresAt);

    const pruned = await this.sessions.deleteExpired();
    if (pruned > 0) logger.info(`[Auth] Pruned ${pruned} expired session(s)`);

    return { user, token, expiresAt };
  }

  /** null for an absent, unknown or expired token. */
  async authenticate(token: string): Promise<AuthenticatedSession | null> {
    const tokenHash = hashSessionToken(token);
    const found = await this.sessions.findByTokenHash(tokenHash);
    if (!found) return null;

    if (!isSessionActive(found.session.expires_at, new Date())) {
      await this.sessions.deleteByTokenHash(tokenHash);
      return null;
    }
    return { user: found.user, tokenHash };
  }

  async logout(token: string): Promise<void> {
    await this.sessions.deleteByTokenHash(hashSessionToken(token));
  }

  /**
   * Changing a password revokes every other session of that user — the point
   * of the change is usually that one of them should not continue.
   */
  async changePassword(
    user: UserRow,
    currentTokenHash: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<UserRow> {
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      throw new InvalidPasswordError();
    }

    const updated = await this.users.updatePasswordHash(
      user.id,
      await hashPassword(newPassword),
    );
    if (!updated) {
      // The row was deleted between authenticating and here.
      throw new InvalidPasswordError();
    }

    const revoked = await this.sessions.deleteForUserExcept(
      user.id,
      currentTokenHash,
    );
    logger.info(
      `[Auth] Password changed for ${user.username}, revoked ${revoked} other session(s)`,
    );
    return updated;
  }
}
