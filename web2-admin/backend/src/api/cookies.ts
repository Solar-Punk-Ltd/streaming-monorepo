import type { CookieOptions, Request, Response } from 'express';

import { SESSION_COOKIE_NAME } from '../types/index.js';

/**
 * The session cookie, by hand: no cookie-parser, no session middleware. One
 * cookie, one value, read and written in one place.
 *
 * httpOnly so script cannot read the token (msrs-client kept its whole session
 * in localStorage), sameSite lax so a normal navigation to the console still
 * sends it, and `secure` only behind TLS — a Secure cookie is dropped outright
 * on the plain-HTTP origins used in development.
 */
export interface SessionCookieConfig {
  secure: boolean;
}

function options(config: SessionCookieConfig): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secure,
    path: '/',
  };
}

export function readSessionToken(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;

    const raw = part.slice(separator + 1).trim();
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // A stray '%' makes decodeURIComponent throw. That must read as "no
      // session", not as a 500 on every request — including the logout that
      // would clear the bad cookie.
      return null;
    }
    return value === '' ? null : value;
  }
  return null;
}

export function setSessionCookie(
  res: Response,
  token: string,
  expiresAt: Date,
  config: SessionCookieConfig,
): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    ...options(config),
    expires: expiresAt,
  });
}

export function clearSessionCookie(
  res: Response,
  config: SessionCookieConfig,
): void {
  // The attributes have to match the ones it was set with, or the browser
  // keeps the original cookie alongside the expired one.
  res.clearCookie(SESSION_COOKIE_NAME, options(config));
}
