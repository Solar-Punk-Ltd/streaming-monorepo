import { SESSION_COOKIE_NAME } from '@streaming-monorepo/web2-admin-common';
import { sessionCookie } from '@streaming-monorepo/web-auth';
import { Request, Response } from 'express';

const cookie = sessionCookie(SESSION_COOKIE_NAME);

/** The session token the browser sent, or null when it sent none or an empty one. */
export function readSessionToken(req: Request): string | null {
  const value = cookie.valueOn(req);
  return value ? value : null;
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  cookie.set(req, res, token);
}

export function clearSessionCookie(req: Request, res: Response): void {
  cookie.clear(req, res);
}
