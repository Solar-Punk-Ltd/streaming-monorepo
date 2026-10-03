import { Request, Response, Router } from 'express';

import type { AdminTokenRotation } from '../../domain/adminLink/AdminTokenRotation.js';
import { profileNameSchema } from '../../schemas/profile.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { signedInUser } from '../middleware/requireSession.js';
import { validateParams } from '../middleware/validate.js';

/**
 * `POST /profiles/:name/admin-token/rotate`: takes the deployment's web2 admin token out so its next deploy
 * generates a new one of its own. Behind the session and the same-site check like every write here; the answer is
 * the sentence the page shows, never a token.
 */
export function createAdminTokenRouter(rotation: Pick<AdminTokenRotation, 'rotate'>): Router {
  const router = Router();

  router.post(
    '/profiles/:name/admin-token/rotate',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { username } = signedInUser(req);
      const answer = await rotation.rotate(req.params.name as string, username);
      res.setHeader('Cache-Control', 'no-store');
      res.json(answer);
    }),
  );

  return router;
}
