import { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS } from '../types/index.js';

import { TooManyAttemptsError } from './errors/index.js';

/**
 * In-memory, per-username failed-login throttle. No dependency, no shared
 * store: one backend process owns the console.
 *
 * Only *failed* attempts against an existing user count, and a success clears
 * the bucket — a legitimate operator who logs in repeatedly is never locked
 * out, while guessing stops after LOGIN_MAX_ATTEMPTS within the window.
 *
 * The map is capped. The endpoint is unauthenticated, so its key space is
 * whatever an attacker types; past the cap the oldest bucket is evicted, which
 * is O(1) and keeps the memory bounded. Losing a bucket that way costs nothing
 * real: it takes LOGIN_MAX_ATTEMPTS *fresh* failures to get back to the limit,
 * and filling the cap to push a bucket out is far more work than the attempts
 * it buys.
 */
const MAX_TRACKED_USERNAMES = 1_000;

export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxAttempts: number = LOGIN_MAX_ATTEMPTS,
    private readonly windowMs: number = LOGIN_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly maxTrackedUsernames: number = MAX_TRACKED_USERNAMES,
  ) {}

  /** How many usernames are being tracked; the cap is an invariant, so tested. */
  get trackedUsernames(): number {
    return this.failures.size;
  }

  /** Throws TooManyAttemptsError when the username is over its budget. */
  check(username: string): void {
    const recent = this.recent(username);
    if (recent.length < this.maxAttempts) return;

    const oldest = recent[0]!;
    const retryAfterMs = oldest + this.windowMs - this.now();
    throw new TooManyAttemptsError(
      username,
      Math.max(1, Math.ceil(retryAfterMs / 1000)),
    );
  }

  recordFailure(username: string): void {
    const recent = this.recent(username);
    recent.push(this.now());
    this.failures.set(username, recent);
    this.evictOldest(username);
  }

  clear(username: string): void {
    this.failures.delete(username);
  }

  /**
   * Keeps the map at the cap by dropping the least recently created bucket.
   * A Map iterates in insertion order and re-`set`ting an existing key does
   * not move it, so the first key is the oldest — except when it is the
   * username just recorded, which is skipped so a failure can never evict
   * itself.
   */
  private evictOldest(current: string): void {
    while (this.failures.size > this.maxTrackedUsernames) {
      let evicted = false;
      for (const key of this.failures.keys()) {
        if (key === current) continue;
        this.failures.delete(key);
        evicted = true;
        break;
      }
      if (!evicted) return;
    }
  }

  /** Attempts still inside the window; also prunes the bucket it touches. */
  private recent(username: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(username) ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) {
      this.failures.delete(username);
    } else {
      this.failures.set(username, kept);
    }
    return kept;
  }
}
