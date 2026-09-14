import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;

/** The value that goes into the cookie. Never stored. */
export function createSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/** What `sessions.token_hash` holds, so a database dump is not a set of logins. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sessionExpiresAt(now: Date, ttlHours: number): Date {
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
}

export function isSessionActive(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() > now.getTime();
}
