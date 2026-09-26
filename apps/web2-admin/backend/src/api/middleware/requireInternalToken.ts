import { createHash, timingSafeEqual } from 'node:crypto';

import { NextFunction, Request, RequestHandler, Response } from 'express';

import { UnauthenticatedError } from '../../domain/errors/index.js';

const BEARER = /^Bearer (.+)$/;

/**
 * `Authorization: Bearer <INTERNAL_API_TOKEN>` — the only way into
 * /api/internal, and a session cookie is not one. The two authentications are
 * mounted on disjoint paths so neither can be mistaken for the other: a
 * console session can never reach the uploader's routes, and this token can
 * never reach a user's streams.
 *
 * Both sides are sha256'd before the comparison. timingSafeEqual needs equal
 * lengths, and hashing gives that for free without leaking the token's length
 * through which requests are rejected early.
 */
export function createRequireInternalToken(token: string): RequestHandler {
  const expected = digest(token);

  return (req: Request, _res: Response, next: NextFunction) => {
    const presented = BEARER.exec(req.get('authorization') ?? '')?.[1];
    if (!presented || !timingSafeEqual(expected, digest(presented.trim()))) {
      next(new UnauthenticatedError());
      return;
    }
    next();
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
