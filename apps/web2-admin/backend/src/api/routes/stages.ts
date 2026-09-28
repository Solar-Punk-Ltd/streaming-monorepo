import type { CatalogueStampResponse, StageListResponse } from '@streaming-monorepo/web2-admin-common';
import { Request, RequestHandler, Response, Router } from 'express';

import { StageService } from '../../domain/StageService.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { toCatalogueStampSummary, toStageSummary } from '../presenters.js';

export interface StageRoutesDeps {
  stageService: StageService;
  requireAuth: RequestHandler;
}

/**
 * `GET /api/stages`: every stage the manager pushed, retired ones included, for the console. Behind the session like
 * every other console route. Read only: the manager is the one that changes a stage.
 */
export function createStagesRouter(deps: StageRoutesDeps): Router {
  const { stageService, requireAuth } = deps;
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      const stages = await stageService.list();
      const response: StageListResponse = { stages: stages.map(toStageSummary) };
      res.json(response);
    }),
  );

  return router;
}

/** `GET /api/catalogue-stamp`: the brand's catalogue batch, or null while none is designated. Behind the session. */
export function createCatalogueStampRouter(deps: StageRoutesDeps): Router {
  const { stageService, requireAuth } = deps;
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      const stamp = await stageService.catalogueStamp();
      const response: CatalogueStampResponse = { catalogueStamp: stamp ? toCatalogueStampSummary(stamp) : null };
      res.json(response);
    }),
  );

  return router;
}
