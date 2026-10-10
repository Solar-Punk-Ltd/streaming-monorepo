import { createHash, timingSafeEqual } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { FundingApiError } from '../../domain/funding/FundingApiError.js';
import { readSessionToken } from '../sessionCookie.js';

const BEARER = /^Bearer (.+)$/i;

/**
 * The token of an `Authorization: Bearer <token>` header, trimmed, or null when there is none or it is empty. The
 * scheme is read in any case and spaces around the token are dropped, as RFC 9110 allows, unlike the web2 admin's
 * `requireInternalToken.ts`, which takes `Bearer` as written; the comparison of the token itself is the same.
 */
function presentedBearer(req: Request): string | null {
  const presented = BEARER.exec(req.get('authorization') ?? '')?.[1]?.trim();
  return presented ? presented : null;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * The gate of the funding API under /api/admin-funding, which the web2 admin calls with
 * `Authorization: Bearer <FUNDING_API_TOKEN>`. Without a token the API is off and every path under it answers 404
 * `funding_off`, whatever was presented. With one, a request needs that bearer and no session cookie: a cookie is the
 * operator's credential, and refusing it here keeps the two scopes apart even when a browser sends both.
 *
 * Both tokens are sha256'd before `timingSafeEqual`, as the web2 admin's `requireInternalToken.ts` compares its own,
 * so the comparison takes the same time whatever was presented and whatever its length. Neither token is logged or
 * answered.
 */
export function createFundingGate(token: string | null): RequestHandler {
  const expected = token === null ? null : digest(token);
  return (req: Request, _res: Response, next: NextFunction) => {
    if (expected === null) {
      next(new FundingApiError('funding_off', 'The funding API is off on this manager.'));
      return;
    }
    const presented = presentedBearer(req);
    if (!presented || readSessionToken(req) !== null || !timingSafeEqual(expected, digest(presented))) {
      next(new FundingApiError('unauthorized', 'The funding API takes its bearer token and no session.'));
      return;
    }
    next();
  };
}

/**
 * Mounted after the funding API and ahead of every operator route: a request that carries a bearer token is refused
 * there, 401, so the funding token opens the funding API and nothing else. No operator route takes a bearer; the
 * console signs in with a session cookie alone.
 */
export const refuseFundingBearer: RequestHandler = (req, res, next) => {
  if (presentedBearer(req) === null) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized', message: 'A bearer token opens the funding API alone.' });
};
