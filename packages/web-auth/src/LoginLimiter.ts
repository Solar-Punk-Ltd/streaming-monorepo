import { limiterAddress } from './clientIp.js';
import { LOGIN_ACCOUNT_CEILING, LOGIN_FORGET_MS, LOGIN_FREE_ATTEMPTS, lockoutMsFor } from './rules.js';

/**
 * Ceiling on tracked keys. Every failed attempt makes an entry under whatever
 * username was sent, and nothing may be forgotten for two hours, so without a
 * cap the map grows with what an attacker chooses to type.
 */
export const MAX_TRACKED_KEYS = 10_000;

/**
 * How many of the oldest keys go when the cap is reached. A batch, so choosing
 * them costs one pass per thousand new keys instead of one per failure.
 */
const EVICTION_BATCH = 1_000;

interface Attempts {
  /** Failures that are over and counted. */
  failures: number;
  /** Attempts reserved by `begin` whose password is still being checked. */
  pending: number;
  lastFailureAt: number;
  lockedUntil: number;
  /** Failures this key gets free before it locks: {@link LOGIN_FREE_ATTEMPTS} unless the key has its own count. */
  freeAttempts: number;
}

/** The account everywhere: the key of the account ceiling, {@link LOGIN_ACCOUNT_CEILING}. */
export function usernameKey(username: string): string {
  return `username:${username.toLowerCase()}`;
}

/** The client address, as {@link limiterAddress} sees it: an IPv6 address by its /64. */
export function clientIpKey(ip: string): string {
  return `ip:${limiterAddress(ip)}`;
}

/**
 * The account at one address: the key a sign-in's free failures and its lockout count on, so guesses from one place
 * lock that account there and nowhere else. The admin's own password checks count on it too.
 */
export function accountAtAddressKey(username: string, ip: string): string {
  return `account:${username.toLowerCase()}@${limiterAddress(ip)}`;
}

/** A user's id as each backend stores it, a serial number or a uuid. */
export type UserId = number | string;

/**
 * Changing a password checks the current one, which is a password check like
 * any other. Its own key, so guessing it neither locks the account out of
 * signing in nor borrows the sign-in count.
 */
export function passwordChangeKey(userId: UserId): string {
  return `password-change:${userId}`;
}

/** A key with a free count of its own, rather than {@link LOGIN_FREE_ATTEMPTS}. */
export interface CountedKey {
  key: string;
  freeAttempts: number;
}

/** The keys one attempt is counted against. */
export interface AttemptKeys {
  /** The account being tried. A right password wipes this key clean. */
  account: string;
  /**
   * Keys many attempts share, such as the client address or the account
   * everywhere. A right password takes only its own attempt back out of these,
   * never anyone else's.
   */
  shared?: readonly (string | CountedKey)[];
}

/**
 * The keys a sign-in counts on: the account at that address, which a right
 * password wipes; the address, across every account; and the account
 * everywhere, the ceiling, whose 99 failures from all addresses together are
 * free and whose 100th locks.
 */
export function signInKeys(username: string, ip: string): AttemptKeys {
  return {
    account: accountAtAddressKey(username, ip),
    shared: [clientIpKey(ip), { key: usernameKey(username), freeAttempts: LOGIN_ACCOUNT_CEILING - 1 }],
  };
}

/**
 * An attempt that has been counted before it was made. Settle it with exactly
 * one of `fail` and `succeed` once the password has been checked.
 */
export interface LoginAttempt {
  /** How long the caller must wait, or 0 when the attempt may go ahead. */
  readonly lockedForSeconds: number;
  /** The password was wrong. The attempt stays counted. */
  fail(): void;
  /** The password was right. The attempt is taken back off the keys. */
  succeed(): void;
}

/** A refused attempt reserved nothing, so it has nothing to settle. */
const NOTHING_TO_SETTLE = {
  fail: () => undefined,
  succeed: () => undefined,
};

/**
 * Brute-force throttling for sign-in, held in memory in the single API process.
 *
 * Five failures on a key lock it for a minute, and every failure after that
 * doubles the wait up to an hour. A sign-in counts on three keys
 * ({@link signInKeys}): the account at that address, the address, and the
 * account everywhere, whose free count is the ceiling's. So guessing from one
 * place locks that place, and many places together lock the account after
 * {@link LOGIN_ACCOUNT_CEILING}, while the owner signs in from elsewhere.
 *
 * In memory rather than in Postgres on purpose: the backend runs as one
 * process, and a limiter that has to survive a restart would be a write per
 * failed guess, which is the thing an attacker controls.
 */
export class LoginLimiter {
  private readonly attempts = new Map<string, Attempts>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Reserves one attempt on every key, before the password is checked.
   *
   * Reading the lockout and recording the failure used to sit either side of an
   * awaited scrypt, so twenty sign-ins sent together all read zero failures and
   * all got their guess. Here the count moves in the same synchronous call that
   * reads it, and only the free attempts get through.
   */
  begin(keys: AttemptKeys): LoginAttempt {
    const counted = [keys.account, ...(keys.shared ?? [])].map((key) =>
      typeof key === 'string' ? { key, freeAttempts: LOGIN_FREE_ATTEMPTS } : key,
    );
    const all = counted.map(({ key }) => key);
    const now = this.now();

    const lockedForSeconds = Math.max(...all.map((key) => this.waitSeconds(key, now)));
    if (lockedForSeconds > 0) return { lockedForSeconds, ...NOTHING_TO_SETTLE };

    if (this.attempts.size >= MAX_TRACKED_KEYS) this.makeRoom(now);
    for (const { key, freeAttempts } of counted) this.reserve(key, freeAttempts, now);

    return {
      lockedForSeconds: 0,
      fail: () => {
        for (const key of all) this.countFailure(key);
      },
      succeed: () => {
        for (const key of all) this.giveTheAttemptBack(key);
        this.attempts.delete(keys.account);
      },
    };
  }

  /** Seconds this key must wait, or 0 when it may try now. */
  retryAfterSeconds(key: string): number {
    return this.waitSeconds(key, this.now());
  }

  /** How many keys are held, which is what MAX_TRACKED_KEYS bounds. */
  trackedKeys(): number {
    return this.attempts.size;
  }

  private waitSeconds(key: string, now: number): number {
    const entry = this.live(key, now);
    if (!entry) return 0;

    // Reserved attempts count towards the lockout even though none of them has
    // come back yet. Without that, twenty guesses sent at once would all pass
    // this check before the first of them had failed.
    const withPending = entry.pending > 0 ? now + lockoutMsFor(entry.failures + entry.pending, entry.freeAttempts) : 0;
    const until = Math.max(entry.lockedUntil, withPending);
    return until <= now ? 0 : Math.ceil((until - now) / 1000);
  }

  private reserve(key: string, freeAttempts: number, now: number): void {
    const entry = this.live(key, now);
    this.attempts.set(key, {
      failures: entry?.failures ?? 0,
      pending: (entry?.pending ?? 0) + 1,
      lastFailureAt: entry?.lastFailureAt ?? now,
      lockedUntil: entry?.lockedUntil ?? 0,
      freeAttempts,
    });
  }

  private countFailure(key: string): void {
    const entry = this.attempts.get(key);
    if (!entry) return;

    const now = this.now();
    const failures = entry.failures + 1;
    this.attempts.set(key, {
      failures,
      pending: Math.max(0, entry.pending - 1),
      lastFailureAt: now,
      lockedUntil: now + lockoutMsFor(failures, entry.freeAttempts),
      freeAttempts: entry.freeAttempts,
    });
  }

  private giveTheAttemptBack(key: string): void {
    const entry = this.attempts.get(key);
    if (!entry) return;

    const pending = Math.max(0, entry.pending - 1);
    if (entry.failures === 0 && pending === 0) {
      this.attempts.delete(key);
      return;
    }
    this.attempts.set(key, { ...entry, pending });
  }

  /** The entry for `key`, dropping it first if it has been quiet long enough. */
  private live(key: string, now: number): Attempts | undefined {
    const entry = this.attempts.get(key);
    if (!entry) return undefined;
    if (isForgettable(entry, now)) {
      this.attempts.delete(key);
      return undefined;
    }
    return entry;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.attempts) {
      if (isForgettable(entry, now)) this.attempts.delete(key);
    }
  }

  /**
   * Drops the keys that failed longest ago, locked or not. A lockout thrown
   * away early is the price of the cap, and the keys chosen are the ones whose
   * attacker has moved on. Attempts still in flight are left alone: their
   * handle has to find them again to settle.
   */
  private makeRoom(now: number): void {
    this.sweep(now);
    if (this.attempts.size < MAX_TRACKED_KEYS) return;

    const oldestFirst = [...this.attempts]
      .filter(([, entry]) => entry.pending === 0)
      .sort(([, a], [, b]) => a.lastFailureAt - b.lastFailureAt);

    for (const [key] of oldestFirst.slice(0, EVICTION_BATCH)) {
      this.attempts.delete(key);
    }
  }
}

function isForgettable(entry: Attempts, now: number): boolean {
  return entry.pending === 0 && entry.lockedUntil <= now && now - entry.lastFailureAt >= LOGIN_FORGET_MS;
}
