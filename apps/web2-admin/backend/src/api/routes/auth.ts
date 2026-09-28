import type { MeResponse, UserListResponse, UserSummary } from '@streaming-monorepo/web2-admin-common';
import { clientIpOf } from '@streaming-monorepo/web-auth';
import { Request, RequestHandler, Response, Router } from 'express';

import { AuthService } from '../../domain/auth/AuthService.js';
import {
  ChangePasswordBody,
  changePasswordSchema,
  CreateUserBody,
  createUserSchema,
  LoginBody,
  loginSchema,
  userIdParamSchema,
} from '../../schemas/auth.js';
import { USER_AGENT_MAX_LENGTH } from '../../types/index.js';
import { clearSessionCookie, readSessionToken, setSessionCookie } from '../cookies.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAdmin, requireUser, signedInSession } from '../middleware/requireAuth.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { toUser } from '../presenters.js';

/** Kept on the session row, so a revoke can be told which browser it drops. */
function userAgentOf(req: Request): string | null {
  const header = req.headers['user-agent'];
  const value = Array.isArray(header) ? header[0] : header;
  return value ? value.slice(0, USER_AGENT_MAX_LENGTH) : null;
}

function userIdOf(req: Request): string {
  return req.params.id as string;
}

/**
 * Signing in, signing out, and who may do either.
 *
 * `POST /login`, `POST /logout` and `GET /session` are the only routes here
 * that answer without a session. `/session` answers 401 either way: it exists
 * so the console can tell "signed out" from "no users have been created yet",
 * which is the state a fresh database is in until the `user:add` CLI has run.
 */
export function createAuthRouter(authService: AuthService, requireAuth: RequestHandler): Router {
  const router = Router();

  router.post(
    '/login',
    validateBody(loginSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as LoginBody;
      const { user, token } = await authService.signIn({
        username: body.username,
        password: body.password,
        ip: clientIpOf(req),
        userAgent: userAgentOf(req),
      });
      setSessionCookie(req, res, token);
      const response: MeResponse = { user: toUser(user) };
      res.json(response);
    }),
  );

  router.post(
    '/logout',
    asyncHandler(async (req: Request, res: Response) => {
      // Unauthenticated: logging out with a stale cookie should clear it, not
      // fail with a 401.
      const token = readSessionToken(req);
      if (token) await authService.signOutToken(token);
      clearSessionCookie(req, res);
      res.status(204).end();
    }),
  );

  router.get(
    '/session',
    asyncHandler(async (req: Request, res: Response) => {
      const token = readSessionToken(req);
      const session = token ? await authService.sessionFor(token) : null;

      if (session) {
        const response: MeResponse = { user: toUser(session.user) };
        res.json(response);
        return;
      }

      if (token) clearSessionCookie(req, res);
      const error = (await authService.countUsers()) === 0 ? 'no_users' : 'unauthenticated';
      res.status(401).json({ error });
    }),
  );

  // Kept for compatibility: it is what the console asked before /session, and
  // it says the same thing, only behind the gate.
  router.get('/me', requireAuth, (req: Request, res: Response) => {
    const { user } = requireUser(req);
    const response: MeResponse = { user: toUser(user) };
    res.json(response);
  });

  router.post(
    '/password',
    requireAuth,
    validateBody(changePasswordSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as ChangePasswordBody;
      const updated = await authService.changePassword(signedInSession(req), body.currentPassword, body.newPassword);
      const response: MeResponse = { user: toUser(updated) };
      res.json(response);
    }),
  );

  router.get(
    '/users',
    requireAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const response: UserListResponse = { users: await authService.listUsers() };
      res.json(response);
    }),
  );

  router.post(
    '/users',
    requireAuth,
    requireAdmin,
    validateBody(createUserSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as CreateUserBody;
      const created: UserSummary = await authService.addUser(body.username, body.password, {
        admin: body.admin === true,
      });
      res.status(201).json(created);
    }),
  );

  router.delete(
    '/users/:id',
    requireAuth,
    requireAdmin,
    validateParams(userIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      await authService.removeUser(userIdOf(req), requireUser(req).user.id);
      res.status(204).end();
    }),
  );

  router.post(
    '/users/:id/revoke',
    requireAuth,
    validateParams(userIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      // Anyone may sign themselves out everywhere. Doing it to someone else
      // is managing users, which AuthService checks.
      await authService.revokeSessions(userIdOf(req), requireUser(req).user);
      res.status(204).end();
    }),
  );

  return router;
}
