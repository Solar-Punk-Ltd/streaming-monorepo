import { createHash, timingSafeEqual } from 'node:crypto';

import { NextFunction, Request, RequestHandler, Response } from 'express';

import { UnauthenticatedError } from '../../domain/errors/index.js';

const BEARER = /^Bearer (.+)$/;

/**
 * The token of an `Authorization: Bearer <token>` header, trimmed, or null when there is none. Every door into
 * /api/internal reads the header this way and no other, so a token one of them takes is presented the same way to
 * the other.
 */
export function presentedBearer(req: Request): string | null {
  const presented = BEARER.exec(req.get('authorization') ?? '')?.[1]?.trim();
  return presented ? presented : null;
}

/**
 * Whether `presented` is `expected`, in constant time. Both sides are sha256'd before the comparison.
 * timingSafeEqual needs equal lengths, and hashing gives that for free without leaking the token's length through
 * which requests are rejected early.
 */
export function sameToken(expected: Buffer, presented: string): boolean {
  return timingSafeEqual(expected, digest(presented));
}

export function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * `Authorization: Bearer <INTERNAL_API_TOKEN>`, the registrar token: the only way into the manager's routes under
 * /api/internal, and a session cookie is not one, nor is a stage's own uploader token. The two authentications are
 * mounted on disjoint paths so neither can be mistaken for the other: a console session can never reach the
 * internal routes, and no internal token can ever reach a user's streams.
 */
export function createRequireInternalToken(token: string): RequestHandler {
  const expected = digest(token);

  return (req: Request, _res: Response, next: NextFunction) => {
    const presented = presentedBearer(req);
    if (!presented || !sameToken(expected, presented)) {
      next(new UnauthenticatedError());
      return;
    }
    next();
  };
}
