import type { VersionInfo } from '@streaming-monorepo/web2-admin-common';
import { Request, RequestHandler, Response, Router } from 'express';

export interface VersionRoutesDeps {
  /** What the deploy built into the image, read once when the process started. */
  version: VersionInfo;
  requireAuth: RequestHandler;
}

/**
 * `GET /api/version`: the build this API runs, the label it was deployed as and its commit, each null when the image
 * carries none. Behind the session, unlike /api/health and /api/config: which build runs is for signed-in users only.
 *
 * `no-store`, as the manager's GET /version is, because a redeploy replaces the answer and a page should never show
 * the build it was loaded with.
 */
export function createVersionRouter(deps: VersionRoutesDeps): Router {
  const { version, requireAuth } = deps;
  const router = Router();

  router.use(requireAuth);

  router.get('/', (_req: Request, res: Response) => {
    const body: VersionInfo = { label: version.label, commit: version.commit };
    res.set('Cache-Control', 'no-store').json(body);
  });

  return router;
}
