import type { MeResponse } from '@streaming-monorepo/web2-admin-common';
import { Request, RequestHandler, Response, Router } from 'express';

import { AuthService } from '../../domain/AuthService.js';
import {
  ChangePasswordBody,
  changePasswordSchema,
  LoginBody,
  loginSchema,
} from '../../schemas/auth.js';
import {
  clearSessionCookie,
  readSessionToken,
  setSessionCookie,
  type SessionCookieConfig,
} from '../cookies.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireUser } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validate.js';
import { toUser } from '../presenters.js';

export function createAuthRouter(
  authService: AuthService,
  cookieConfig: SessionCookieConfig,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.post(
    '/login',
    validateBody(loginSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as LoginBody;
      const { user, token, expiresAt } = await authService.login(
        body.username,
        body.password,
      );
      setSessionCookie(res, token, expiresAt, cookieConfig);
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
      if (token) await authService.logout(token);
      clearSessionCookie(res, cookieConfig);
      res.status(204).end();
    }),
  );

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
      const { user, tokenHash } = requireUser(req);
      const body = req.body as ChangePasswordBody;
      const updated = await authService.changePassword(
        user,
        tokenHash,
        body.currentPassword,
        body.newPassword,
      );
      const response: MeResponse = { user: toUser(updated) };
      res.json(response);
    }),
  );

  return router;
}
