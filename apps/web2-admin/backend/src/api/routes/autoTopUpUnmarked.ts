import type { AutoTopUpUnmarkedView } from '@streaming-monorepo/web2-admin-common';
import { Request, RequestHandler, Response, Router } from 'express';

import { unmarkedStampsView } from '../../domain/funding/UnmarkedStampPass.js';
import type { UnmarkedStampStore } from '../../domain/funding/UnmarkedStampStore.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export interface AutoTopUpUnmarkedRoutesDeps {
  /** Where the alert job keeps the stamps not on auto top-up that are running low. */
  unmarkedStamps: Pick<UnmarkedStampStore, 'rows'>;
  requireAuth: RequestHandler;
}

/**
 * The list of the stamps not on auto top-up that are running low, which the Auto top-up tab shows, under
 * `/api/funding/auto-top-up/unmarked` (`FUNDING_AUTO_TOPUP_UNMARKED_PATH`), behind the session.
 *
 * - `GET /` answers `AutoTopUpUnmarkedView`: every stamp the alert job's last run left listed, the least time left
 *   first (`unmarkedStampsView`). It reads the database alone and asks the manager nothing.
 */
export function createAutoTopUpUnmarkedRouter(deps: AutoTopUpUnmarkedRoutesDeps): Router {
  const { unmarkedStamps, requireAuth } = deps;
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      const response: AutoTopUpUnmarkedView = unmarkedStampsView(await unmarkedStamps.rows());
      res.json(response);
    }),
  );

  return router;
}
