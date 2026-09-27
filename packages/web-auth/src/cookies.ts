import type { CookieOptions, Request, Response } from 'express';

/**
 * The cookies on a request, by name.
 *
 * A Map rather than an object: cookie names come from the network and a name
 * like `__proto__` must stay an ordinary key. Malformed pairs are skipped
 * rather than throwing, because a browser sends whatever it was given and one
 * bad cookie must not refuse the request.
 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;

    const name = pair.slice(0, separator).trim();
    if (name === '') continue;

    const raw = pair.slice(separator + 1).trim();
    const unquoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;

    cookies.set(name, decodeValue(unquoted));
  }

  return cookies;
}

function decodeValue(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    // A stray '%' makes decodeURIComponent throw. The value is handed back as
    // it arrived rather than becoming a 500 on every request the browser makes,
    // the sign-out that would clear the bad cookie included.
    return value;
  }
}

/**
 * `Secure` only when the browser really did use HTTPS: the TLS edge says so
 * with `X-Forwarded-Proto`, and a direct TLS connection shows up as
 * `req.secure`.
 *
 * It used to be set for any production build, and an image always is one. A
 * browser reaching the app over plain HTTP at anything but localhost then
 * dropped the cookie it had just been given, so signing in came straight back
 * to the sign-in page with nothing to show for it.
 */
function isSecureRequest(req: Request): boolean {
  const header = req.headers['x-forwarded-proto'];
  const value = Array.isArray(header) ? header[0] : header;
  const edgeProtocol = value?.split(',')[0]?.trim().toLowerCase();

  return edgeProtocol === 'https' || req.secure;
}

/**
 * httpOnly so script cannot read the token, and lax so a normal navigation to
 * the app still sends it. No `maxAge` and no `expires`: the server's sessions
 * row is the only clock, and a cookie with a deadline of its own would be a
 * second one to keep in step.
 */
function cookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isSecureRequest(req),
  };
}

/** One app's session cookie, read and written in one place. */
export interface SessionCookie {
  /** The cookie's value as the browser sent it, or undefined when it sent none. */
  valueOn(req: Request): string | undefined;
  set(req: Request, res: Response, token: string): void;
  clear(req: Request, res: Response): void;
}

/** The session cookie by hand, no cookie-parser and no session middleware, under the app's own name. */
export function sessionCookie(name: string): SessionCookie {
  return {
    valueOn: (req) => parseCookies(req.headers.cookie).get(name),
    set: (req, res, token) => {
      res.cookie(name, token, cookieOptions(req));
    },
    clear: (req, res) => {
      // The attributes have to match the ones it was set with, or the browser
      // keeps the original cookie alongside the expired one.
      res.clearCookie(name, cookieOptions(req));
    },
  };
}
