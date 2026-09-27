import { SESSION_COOKIE_NAME } from '@streaming-infra-manager/common';
import { sessionCookie } from '@streaming-monorepo/web-auth';
import { Request, Response } from 'express';

const cookie = sessionCookie(SESSION_COOKIE_NAME);

/**
 * The session token the browser sent, or null when it sent none. An empty
 * value comes back as an empty string, which every caller treats as none.
 */
export function readSessionToken(req: Request): string | null {
  return cookie.valueOn(req) ?? null;
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  cookie.set(req, res, token);
}

export function clearSessionCookie(req: Request, res: Response): void {
  cookie.clear(req, res);
}
