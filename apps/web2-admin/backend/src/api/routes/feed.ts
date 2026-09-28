import type { FeedReconcileResult } from '@streaming-monorepo/web2-admin-common';
import { Request, RequestHandler, Response, Router } from 'express';

import { PublishService } from '../../domain/PublishService.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { actorOf } from '../middleware/requireAuth.js';

export interface FeedRoutesDeps {
  publishService: PublishService;
  requireAuth: RequestHandler;
}

/**
 * Operations on the stream list feed as a whole, rather than on one stream.
 *
 * Behind the same session auth as the stream routes: reconcile rewrites the
 * catalogue, which is exactly what publishing does, and it acts on every
 * stream of the installation the same way, whoever runs it. No body — there
 * is nothing to choose; what the feed should say is whatever the database
 * says.
 */
export function createFeedRouter(deps: FeedRoutesDeps): Router {
  const { publishService, requireAuth } = deps;
  const router = Router();

  router.use(requireAuth);

  router.post(
    '/reconcile',
    asyncHandler(async (req: Request, res: Response) => {
      const outcome = await publishService.reconcile(actorOf(req));
      const response: FeedReconcileResult = outcome;
      res.json(response);
    }),
  );

  return router;
}
