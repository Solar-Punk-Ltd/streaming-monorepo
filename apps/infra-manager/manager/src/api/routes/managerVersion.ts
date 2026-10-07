import type { VersionInfo } from '@streaming-infra-manager/common';
import { Request, Response, Router } from 'express';

/**
 * The build this manager runs, `{ label, commit }`, as the deploy built it into the api image and the config read it
 * at startup. Mounted behind the session gate: which build a host runs is for its signed-in users, and nothing that
 * answers without a session carries it.
 *
 * `no-store`, because a redeploy replaces the answer and a page should never show the build it was loaded with.
 */
export function createManagerVersionRouter(version: VersionInfo): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store').json({ label: version.label, commit: version.commit });
  });

  return router;
}
