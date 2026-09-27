import { randomBytes } from 'node:crypto';

import { passwordProblem, usernameProblem, type UserSummary } from '@streaming-monorepo/web2-admin-common';
import {
  absoluteExpiryFrom,
  clientIpKey,
  createSessionToken,
  endsAt,
  hashPassword,
  hashSessionToken,
  hasExpired,
  idleSince,
  LoginLimiter,
  needsTouch,
  passwordChangeKey,
  usernameKey,
  verifyPassword,
} from '@streaming-monorepo/web-auth';

import type { UserRow } from '../../types/index.js';
import {
  AdminRequiredError,
  CannotRemoveUserError,
  InvalidCredentialsError,
  InvalidUsernameError,
  NoUsersError,
  TooManyAttemptsError,
  UserExistsError,
  UserNotFoundError,
  WeakPasswordError,
} from '../errors/index.js';
import { Logger } from '../Logger.js';

import type { CredentialRepository } from './CredentialRepository.js';
import type { SessionRepository } from './SessionRepository.js';
import type { UserRepository } from './UserRepository.js';

const logger = Logger.getInstance();

/** A live session: who it is, which session it is, and when it runs out. */
export interface SessionInfo {
  user: UserRow;
  tokenHash: string;
  /** When this session stops working if nothing else touches it. */
  expiresAt: Date;
}

export interface AddUserOptions {
  /** Let the new user add and remove users too. */
  admin?: boolean;
}

export interface SignInInput {
  username: string;
  password: string;
  ip: string;
  userAgent: string | null;
}

export interface SignInResult {
  user: UserRow;
  /** The cookie value. Only its hash reaches the database. */
  token: string;
  expiresAt: Date;
}

/**
 * Who may use the console, and which sessions are open. Ported from
 * streaming-infra-manager's `manager/src/domain/auth/AuthService.ts`.
 *
 * Everything that decides whether a request gets in is here: the password
 * check, the lockout, the session's two clocks. The middleware and the routes
 * around it only translate between HTTP and these calls.
 *
 * The manager's version also holds an `OpenStreams` registry, so that revoking
 * a session kills the Server-Sent Events connections it left open. This
 * backend has no SSE — nothing outlives the request that opened it — so that
 * collaborator is deliberately absent rather than forgotten. See
 * docs/architecture/web2-admin-auth.md.
 */
export class AuthService {
  /**
   * A throwaway hash to check an unknown username against, so a sign-in for a
   * name that does not exist costs the same time as one for a name that does.
   * Built in the background at startup, and an empty string if that fails,
   * which verifyPassword refuses like any other unreadable hash.
   */
  private readonly decoyHash: Promise<string>;

  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly credentials: CredentialRepository,
    private readonly limiter: LoginLimiter = new LoginLimiter(),
  ) {
    this.decoyHash = hashPassword(randomBytes(32).toString('base64')).catch(() => '');
  }

  countUsers(): Promise<number> {
    return this.users.count();
  }

  async signIn(input: SignInInput): Promise<SignInResult> {
    if ((await this.users.count()) === 0) throw new NoUsersError();

    // Reserved before the lookup and the hash, both of which are awaited: the
    // guesses that arrive together have to be counted before any of them is
    // checked, or they all pass a lockout that none of them has moved yet.
    const attempt = this.limiter.begin({
      account: usernameKey(input.username),
      shared: [clientIpKey(input.ip)],
    });
    if (attempt.lockedForSeconds > 0) {
      logger.warn(
        `[Auth] sign-in refused, locked out: username="${input.username}" ip=${input.ip} retryAfter=${attempt.lockedForSeconds}s`,
      );
      throw new TooManyAttemptsError(attempt.lockedForSeconds);
    }

    const user = await this.users.findByUsername(input.username);
    // The decoy keeps the cost of an unknown name the same as a known one, so
    // the clock does not say which usernames exist.
    const matches = await verifyPassword(input.password, user ? user.password_hash : await this.decoyHash);

    if (!user || !matches) {
      attempt.fail();
      logger.warn(`[Auth] failed sign-in: username="${input.username}" ip=${input.ip}`);
      throw new InvalidCredentialsError();
    }

    attempt.succeed();

    const now = new Date();
    await this.sessions.deleteExpired(now, idleSince(now));

    const token = createSessionToken();
    const expiresAt = absoluteExpiryFrom(now);
    await this.sessions.create({
      tokenHash: hashSessionToken(token),
      userId: user.id,
      expiresAt,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    await this.users.markSignedIn(user.id, now);

    logger.info(`[Auth] ${user.username} signed in from ${input.ip}`);
    return { user: { ...user, last_login_at: now }, token, expiresAt };
  }

  async signOut(session: SessionInfo): Promise<void> {
    await this.sessions.deleteByTokenHash(session.tokenHash);
  }

  /** Signing out with a cookie that no longer opens anything. */
  async signOutToken(token: string): Promise<void> {
    await this.sessions.deleteByTokenHash(hashSessionToken(token));
  }

  /** The session behind a cookie value, or null when it is unknown or over. */
  async sessionFor(token: string): Promise<SessionInfo | null> {
    const tokenHash = hashSessionToken(token);
    const session = await this.sessions.findByTokenHash(tokenHash);
    if (!session) return null;

    const now = new Date();
    if (hasExpired(session, now)) {
      await this.sessions.deleteByTokenHash(tokenHash);
      return null;
    }

    const touch = needsTouch(session, now);
    if (touch) await this.sessions.touch(tokenHash, now);

    return {
      user: session.user,
      tokenHash,
      expiresAt: endsAt({
        ...session,
        lastSeenAt: touch ? now : session.lastSeenAt,
      }),
    };
  }

  async listUsers(): Promise<UserSummary[]> {
    const now = new Date();
    const [rows, sessionCounts] = await Promise.all([
      this.users.list(),
      this.sessions.countActiveByUser(now, idleSince(now)),
    ]);

    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      isAdmin: row.is_admin,
      createdAt: row.created_at.toISOString(),
      lastLoginAt: row.last_login_at?.toISOString() ?? null,
      sessions: sessionCounts.get(row.id) ?? 0,
    }));
  }

  /**
   * The first user ever added can manage users whatever the caller asked,
   * because somebody has to be able to add the second.
   */
  async addUser(username: string, password: string, options: AddUserOptions = {}): Promise<UserSummary> {
    const badName = usernameProblem(username);
    if (badName) throw new InvalidUsernameError(badName);

    const problem = passwordProblem(password, username);
    if (problem) throw new WeakPasswordError(problem);

    const isAdmin = options.admin === true || (await this.users.count()) === 0;
    const row = await this.users.insert(username, await hashPassword(password), isAdmin);
    if (!row) throw new UserExistsError(username);

    logger.info(`[Auth] user added: ${username}${isAdmin ? ' (can manage users)' : ''}`);
    return {
      id: row.id,
      username: row.username,
      isAdmin: row.is_admin,
      createdAt: row.created_at.toISOString(),
      lastLoginAt: null,
      sessions: 0,
    };
  }

  async removeUser(userId: string, actingUserId: string): Promise<void> {
    if (userId === actingUserId) {
      throw new CannotRemoveUserError('You cannot remove your own account. Ask another user to remove it.');
    }

    const outcome = await this.users.deleteUnlessLast(userId);
    if (outcome === 'missing') throw new UserNotFoundError(userId);
    if (outcome === 'last') {
      throw new CannotRemoveUserError('This is the last user. Removing it would lock everyone out.');
    }
    if (outcome === 'last_admin') {
      throw new CannotRemoveUserError(
        'This is the only user who can manage users. Removing it would leave nobody able to add or remove one.',
      );
    }
    logger.info(`[Auth] user removed: id=${userId}`);
  }

  /**
   * Signs a user out everywhere. Anyone may do it to themselves; doing it to
   * someone else is managing users.
   */
  async revokeSessions(userId: string, actingUser: UserRow): Promise<void> {
    if (!actingUser.is_admin && actingUser.id !== userId) {
      throw new AdminRequiredError();
    }
    if (!(await this.users.findById(userId))) {
      throw new UserNotFoundError(userId);
    }
    await this.sessions.deleteForUser(userId);
    logger.info(`[Auth] sessions revoked for user id=${userId}`);
  }

  /**
   * Change your own password. Every other session of yours is signed out, so a
   * password changed because it leaked also drops whoever had it.
   *
   * The current password is throttled like a sign-in: a stolen session would
   * otherwise be an unlimited guessing machine for the password behind it.
   */
  async changePassword(session: SessionInfo, current: string, next: string): Promise<UserRow> {
    const attempt = this.limiter.begin({
      account: passwordChangeKey(session.user.id),
    });
    if (attempt.lockedForSeconds > 0) {
      logger.warn(
        `[Auth] password change refused, locked out: ${session.user.username} retryAfter=${attempt.lockedForSeconds}s`,
      );
      throw new TooManyAttemptsError(attempt.lockedForSeconds);
    }

    const user = await this.users.findById(session.user.id);
    if (!user) throw new UserNotFoundError(session.user.id);

    if (!(await verifyPassword(current, user.password_hash))) {
      attempt.fail();
      logger.warn(`[Auth] password change refused, wrong current password: ${user.username}`);
      throw new InvalidCredentialsError();
    }
    attempt.succeed();

    const problem = passwordProblem(next, user.username);
    if (problem) throw new WeakPasswordError(problem);

    const changedAt = new Date();
    await this.credentials.changePassword(user.id, await hashPassword(next), session.tokenHash);
    logger.info(`[Auth] password changed: ${user.username}`);
    return { ...user, password_changed_at: changedAt, updated_at: changedAt };
  }

  async deleteExpiredSessions(): Promise<number> {
    const now = new Date();
    return this.sessions.deleteExpired(now, idleSince(now));
  }
}
