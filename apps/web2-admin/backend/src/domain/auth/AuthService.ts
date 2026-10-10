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
import { describeActor, operatorActor, type Actor, type OperatorActor } from '../actor.js';
import { recordAudit, type AuditLog } from '../AuditLog.js';
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
 *
 * Adding and removing a user, revoking sessions and changing a password are
 * audited (migration 007), with the acting user and the one acted on. Signing
 * in and out are not audited. A sign-in has a log line of its own; a sign-out
 * deletes its session row and logs nothing beyond the `[HTTP]` request line.
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
    private readonly audit: AuditLog,
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
    const admitted = await this.credentials.admitSession(
      user.id,
      user.password_hash,
      { tokenHash: hashSessionToken(token), userId: user.id, expiresAt, ip: input.ip, userAgent: input.userAgent },
      now,
    );
    if (!admitted) {
      logger.warn(`[Auth] sign-in refused, the password changed while it was checked: username="${input.username}"`);
      throw new InvalidCredentialsError();
    }

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
   * because somebody has to be able to add the second. `actor` is the
   * operator adding them, or `system (cli)` for the `user:add` CLI.
   */
  async addUser(actor: Actor, username: string, password: string, options: AddUserOptions = {}): Promise<UserSummary> {
    const badName = usernameProblem(username);
    if (badName) throw new InvalidUsernameError(badName);

    const problem = passwordProblem(password, username);
    if (problem) throw new WeakPasswordError(problem);

    const isAdmin = options.admin === true || (await this.users.count()) === 0;
    const row = await this.users.insert(username, await hashPassword(password), isAdmin);
    if (!row) throw new UserExistsError(username);

    logger.info(`[Auth] ${describeActor(actor)} added user ${username}${isAdmin ? ' (can manage users)' : ''}`);
    await recordAudit(this.audit, {
      actor,
      action: 'user.add',
      details: { userId: row.id, username: row.username, isAdmin: row.is_admin },
    });
    return {
      id: row.id,
      username: row.username,
      isAdmin: row.is_admin,
      createdAt: row.created_at.toISOString(),
      lastLoginAt: null,
      sessions: 0,
    };
  }

  async removeUser(actor: OperatorActor, userId: string): Promise<void> {
    if (userId === actor.userId) {
      throw new CannotRemoveUserError('You cannot remove your own account. Ask another user to remove it.');
    }

    // Read first, so the log and the audit row can name who is gone.
    const target = await this.users.findById(userId);
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
    const username = target?.username ?? null;
    logger.info(`[Auth] ${describeActor(actor)} removed user ${username ?? `id=${userId}`}`);
    await recordAudit(this.audit, {
      actor,
      action: 'user.remove',
      details: { userId, username },
    });
  }

  /**
   * Signs a user out everywhere. Anyone may do it to themselves; doing it to
   * someone else is managing users.
   */
  async revokeSessions(userId: string, actingUser: UserRow): Promise<void> {
    if (!actingUser.is_admin && actingUser.id !== userId) {
      throw new AdminRequiredError();
    }
    const target = await this.users.findById(userId);
    if (!target) throw new UserNotFoundError(userId);

    await this.sessions.deleteForUser(userId);
    const actor = operatorActor(actingUser);
    const whose = target.id === actingUser.id ? 'their own sessions' : `the sessions of ${target.username}`;
    logger.info(`[Auth] ${describeActor(actor)} revoked ${whose}`);
    await recordAudit(this.audit, {
      actor,
      action: 'user.sessions.revoke',
      details: { userId, username: target.username },
    });
  }

  /**
   * Change your own password. Every other session of yours is signed out, so a
   * password changed because it leaked also drops whoever had it.
   *
   * The current password is throttled like a sign-in: a stolen session would
   * otherwise be an unlimited guessing machine for the password behind it.
   */
  async changePassword(session: SessionInfo, current: string, next: string): Promise<UserRow> {
    const user = await this.checkOwnPassword(session, current, 'password change');

    const problem = passwordProblem(next, user.username);
    if (problem) throw new WeakPasswordError(problem);

    const changedAt = new Date();
    const changed = await this.credentials.changePassword(
      user.id,
      user.password_hash,
      await hashPassword(next),
      session.tokenHash,
    );
    if (!changed) {
      logger.warn(`[Auth] password change refused, the password changed while it was checked: ${user.username}`);
      throw new InvalidCredentialsError();
    }
    const actor = operatorActor(user);
    logger.info(`[Auth] ${describeActor(actor)} changed their password`);
    await recordAudit(this.audit, {
      actor,
      action: 'user.password.change',
      details: { userId: user.id, username: user.username },
    });
    return { ...user, password_changed_at: changedAt, updated_at: changedAt };
  }

  /**
   * Asks the signed-in user's own password again, for a write that needs it besides the session: pinning a node's
   * wallet or sending from the brand wallet (docs/architecture/funding.md). Checked exactly as a password change
   * checks the current one, behind the same limiter and under the same key, so a stolen session gets no more guesses
   * by spreading them over both: a wrong one is `InvalidCredentialsError`, and once locked out every one is
   * `TooManyAttemptsError`. `purpose` names the write in the log line of a refusal. Answers the user as stored now.
   */
  confirmPassword(session: SessionInfo, password: string, purpose: string): Promise<UserRow> {
    return this.checkOwnPassword(session, password, purpose);
  }

  /** The current password of the session's user, throttled like a sign-in under the password change's key. */
  private async checkOwnPassword(session: SessionInfo, password: string, purpose: string): Promise<UserRow> {
    const attempt = this.limiter.begin({
      account: passwordChangeKey(session.user.id),
    });
    if (attempt.lockedForSeconds > 0) {
      logger.warn(
        `[Auth] ${purpose} refused, locked out: ${session.user.username} retryAfter=${attempt.lockedForSeconds}s`,
      );
      throw new TooManyAttemptsError(attempt.lockedForSeconds);
    }

    const user = await this.users.findById(session.user.id);
    if (!user) throw new UserNotFoundError(session.user.id);

    if (!(await verifyPassword(password, user.password_hash))) {
      attempt.fail();
      logger.warn(`[Auth] ${purpose} refused, wrong current password: ${user.username}`);
      throw new InvalidCredentialsError();
    }
    attempt.succeed();
    return user;
  }

  async deleteExpiredSessions(): Promise<number> {
    const now = new Date();
    return this.sessions.deleteExpired(now, idleSince(now));
  }
}
