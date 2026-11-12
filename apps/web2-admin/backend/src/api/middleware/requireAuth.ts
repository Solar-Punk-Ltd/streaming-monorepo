import { BACKGROUND_READ_HEADER, BACKGROUND_READ_VALUE } from '@streaming-monorepo/web2-admin-common';
import { NextFunction, Request, RequestHandler, Response } from 'express';

import { operatorActor, type OperatorActor } from '../../domain/actor.js';
import type { AuthService, SessionInfo } from '../../domain/auth/AuthService.js';
import { AdminRequiredError, UnauthenticatedError } from '../../domain/errors/index.js';
import type { UserRow } from '../../types/index.js';
import { clearSessionCookie, readSessionToken } from '../cookies.js';

/**
 * The gate. Loads the session named by the cookie and puts the user on the
 * request; everything mounted behind it needs a live session.
 *
 * A cookie that no longer opens anything is cleared on the way out, so a
 * browser that has been away for a fortnight stops sending a dead token.
 *
 * A background read, a GET with the header the console's own timer sends,
 * passes the same checks but leaves the session's idle clock alone, so a
 * console left open still signs out once it has been idle too long.
 */
export function createRequireAuth(authService: AuthService): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = readSessionToken(req);
      const background = req.method === 'GET' && req.get(BACKGROUND_READ_HEADER) === BACKGROUND_READ_VALUE;
      const session = token ? await authService.sessionFor(token, { touch: !background }) : null;
      if (!session) {
        if (token) clearSessionCookie(req, res);
        throw new UnauthenticatedError();
      }

      req.authSession = session;
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

/**
 * The signed-in user as the actor of whatever this request changes. Every
 * mutating service call behind the gate takes it, so the log line and the
 * audit row say which operator it was.
 */
export function actorOf(req: Request): OperatorActor {
  return operatorActor(requireUser(req).user);
}

/** The whole session on a request that came through requireAuth. */
export function signedInSession(req: Request): SessionInfo {
  if (!req.authSession) throw new UnauthenticatedError();
  return req.authSession;
}

/** Mounted after `requireAuth`: refuses anyone who cannot manage users. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  next(requireUser(req).user.is_admin ? undefined : new AdminRequiredError());
};
