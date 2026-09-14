import { NextFunction, Request, RequestHandler, Response } from 'express';

import { AuthService } from '../../domain/AuthService.js';
import { UnauthenticatedError } from '../../domain/errors/index.js';
import type { UserRow } from '../../types/index.js';
import { readSessionToken } from '../cookies.js';

/**
 * Loads the session named by the cookie and puts the user on the request.
 * Everything under /api/streams and /api/auth/{me,password} is behind it.
 */
export function createRequireAuth(authService: AuthService): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = readSessionToken(req);
      const session = token ? await authService.authenticate(token) : null;
      if (!session) throw new UnauthenticatedError();

      req.user = session.user;
      req.sessionTokenHash = session.tokenHash;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Reads what requireAuth set, without `undefined` leaking into handlers. */
export function requireUser(req: Request): {
  user: UserRow;
  tokenHash: string;
} {
  if (!req.user || !req.sessionTokenHash) throw new UnauthenticatedError();
  return { user: req.user, tokenHash: req.sessionTokenHash };
}
