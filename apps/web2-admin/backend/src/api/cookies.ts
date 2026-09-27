import { SESSION_COOKIE_NAME } from '@streaming-monorepo/web2-admin-common';
import { CookieOptions, Request, Response } from 'express';

import { parseCookies } from '../utils/cookies.js';

/**
 * The session cookie, by hand: no cookie-parser, no session middleware. One
 * cookie, one value, read and written in one place.
 *
 * httpOnly so script cannot read the token and
 * sameSite lax so a normal navigation to the console still
 * sends it.
 *
 * No `maxAge` and no `expires`, so the browser holds it for the life of the
 * tab: the server's `sessions` row is the only clock, and a cookie with its own
 * deadline would be a second one to keep in step. The 12-hour idle and 14-day
 * absolute limits are enforced on every request.
 *
 * `Secure` is computed per request rather than read from configuration, because
 * it used to be set for any production build and the image always is one: a
 * browser reaching the backend over plain HTTP at anything but localhost then
 * dropped the cookie it had just been given, so signing in came straight back
 * to the sign-in page with nothing to show for it. The TLS edge says so with
 * `X-Forwarded-Proto` and a direct TLS connection shows up as `req.secure`.
 */
function isSecureRequest(req: Request): boolean {
  const header = req.headers['x-forwarded-proto'];
  const value = Array.isArray(header) ? header[0] : header;
  const edgeProtocol = value?.split(',')[0]?.trim().toLowerCase();

  return edgeProtocol === 'https' || req.secure;
}

function cookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isSecureRequest(req),
  };
}

/** The session token the browser sent, or null when it sent none. */
export function readSessionToken(req: Request): string | null {
  const value = parseCookies(req.headers.cookie).get(SESSION_COOKIE_NAME);
  return value ? value : null;
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, cookieOptions(req));
}

export function clearSessionCookie(req: Request, res: Response): void {
  // The attributes have to match the ones it was set with, or the browser
  // keeps the original cookie alongside the expired one.
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions(req));
}
