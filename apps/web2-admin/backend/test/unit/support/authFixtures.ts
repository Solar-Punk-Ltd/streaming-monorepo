/**
 * The users, sessions and credentials tables without Postgres.
 *
 * Rows go in and come out as copies, so a test holding one cannot change what
 * the repository stores. `deleteUnlessLast` keeps the same three refusals the
 * SQL does, because those are the rules, not an implementation detail of the
 * statement that enforces them.
 */
import type { CredentialRepository } from '../../../src/domain/auth/CredentialRepository.js';
import type {
  NewSession,
  SessionRepository,
  StoredSession,
} from '../../../src/domain/auth/SessionRepository.js';
import type {
  UserDeletion,
  UserRepository,
} from '../../../src/domain/auth/UserRepository.js';
import type { UserRow } from '../../../src/types/index.js';

let sequence = 0;

/** A UUID like the database mints, but predictable. */
export function nextUserId(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

export function userRow(over: Partial<UserRow> = {}): UserRow {
  const at = new Date('2026-09-11T10:00:00.000Z');
  return {
    id: nextUserId(),
    username: 'owner',
    password_hash: 'scrypt$32768$8$3$c2FsdA==$a2V5',
    is_admin: true,
    password_changed_at: null,
    last_login_at: null,
    created_at: at,
    updated_at: at,
    ...over,
  };
}

export class InMemoryUserRepository implements UserRepository {
  private rows: UserRow[] = [];
  private lookups = 0;

  async count(): Promise<number> {
    return this.rows.length;
  }

  async list(): Promise<UserRow[]> {
    return this.rows.map((row) => ({ ...row }));
  }

  async findById(id: string): Promise<UserRow | null> {
    const row = this.rows.find((candidate) => candidate.id === id);
    return row ? { ...row } : null;
  }

  async findByUsername(username: string): Promise<UserRow | null> {
    this.lookups += 1;
    const row = this.rows.find((candidate) => candidate.username === username);
    return row ? { ...row } : null;
  }

  async insert(
    username: string,
    passwordHash: string,
    isAdmin: boolean,
  ): Promise<UserRow | null> {
    if (this.rows.some((row) => row.username === username)) return null;

    const now = new Date();
    const row = userRow({
      username,
      password_hash: passwordHash,
      is_admin: isAdmin,
      created_at: now,
      updated_at: now,
    });
    this.rows = [...this.rows, row];
    return { ...row };
  }

  /** Half of a password change, which InMemoryCredentialRepository pairs up. */
  setPasswordHash(id: string, passwordHash: string): void {
    this.rows = this.rows.map((row) =>
      row.id === id
        ? { ...row, password_hash: passwordHash, password_changed_at: new Date() }
        : row,
    );
  }

  async markSignedIn(id: string, at: Date): Promise<void> {
    this.rows = this.rows.map((row) =>
      row.id === id ? { ...row, last_login_at: at } : row,
    );
  }

  async deleteUnlessLast(id: string): Promise<UserDeletion> {
    const target = this.rows.find((row) => row.id === id);
    if (!target) return 'missing';
    if (this.rows.length <= 1) return 'last';
    if (target.is_admin && this.rows.filter((row) => row.is_admin).length <= 1) {
      return 'last_admin';
    }

    this.rows = this.rows.filter((row) => row.id !== id);
    return 'deleted';
  }

  /**
   * Test-only view. Signing in looks the username up and then hashes the
   * password with no branch in between, so this counts the attempts that got
   * as far as paying for a scrypt.
   */
  usernameLookups(): number {
    return this.lookups;
  }
}

interface SessionRecord {
  tokenHash: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

/**
 * It asks the user repository for the row on every read, which is both the join
 * the real query does and the cascade on a deleted user: a session whose owner
 * is gone reads as no session at all.
 */
export class InMemorySessionRepository implements SessionRepository {
  private rows = new Map<string, SessionRecord>();

  constructor(private readonly users: UserRepository) {}

  async create(session: NewSession): Promise<void> {
    const now = new Date();
    this.rows.set(session.tokenHash, {
      tokenHash: session.tokenHash,
      userId: session.userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: session.expiresAt,
    });
  }

  async findByTokenHash(tokenHash: string): Promise<StoredSession | null> {
    const row = this.rows.get(tokenHash);
    if (!row) return null;

    const user = await this.users.findById(row.userId);
    if (!user) return null;

    return {
      tokenHash: row.tokenHash,
      user,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
    };
  }

  async touch(tokenHash: string, seenAt: Date): Promise<void> {
    const row = this.rows.get(tokenHash);
    if (row) this.rows.set(tokenHash, { ...row, lastSeenAt: seenAt });
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    this.rows.delete(tokenHash);
  }

  async deleteForUser(userId: string): Promise<void> {
    this.removeWhere((row) => row.userId === userId);
  }

  /** The other half of a password change, paired with the hash write. */
  deleteForUserExcept(userId: string, keepTokenHash: string): void {
    this.removeWhere(
      (row) => row.userId === userId && row.tokenHash !== keepTokenHash,
    );
  }

  async deleteExpired(now: Date, idleSince: Date): Promise<number> {
    return this.removeWhere(
      (row) => row.expiresAt <= now || row.lastSeenAt <= idleSince,
    );
  }

  async countActiveByUser(
    now: Date,
    idleSince: Date,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const row of this.rows.values()) {
      if (row.expiresAt <= now || row.lastSeenAt <= idleSince) continue;
      counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1);
    }
    return counts;
  }

  /** Test-only view, so a test can assert what a revoke actually removed. */
  size(): number {
    return this.rows.size;
  }

  private removeWhere(matches: (row: SessionRecord) => boolean): number {
    const kept = new Map<string, SessionRecord>();
    let removed = 0;
    for (const [tokenHash, row] of this.rows) {
      if (matches(row)) removed += 1;
      else kept.set(tokenHash, row);
    }
    this.rows = kept;
    return removed;
  }
}

/**
 * The password change without Postgres. It reaches into both in-memory tables
 * because that is what the one transaction in the Postgres version does, and
 * neither write can be observed between the two: nothing here awaits.
 */
export class InMemoryCredentialRepository implements CredentialRepository {
  constructor(
    private readonly users: InMemoryUserRepository,
    private readonly sessions: InMemorySessionRepository,
  ) {}

  async changePassword(
    userId: string,
    passwordHash: string,
    keepSessionTokenHash: string,
  ): Promise<void> {
    this.users.setPasswordHash(userId, passwordHash);
    this.sessions.deleteForUserExcept(userId, keepSessionTokenHash);
  }
}
