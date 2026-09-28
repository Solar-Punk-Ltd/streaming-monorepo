import type { CatalogueStampResponse, StageListResponse } from '@streaming-monorepo/web2-admin-common';
import { Request, RequestHandler, Response, Router } from 'express';

import type { CatalogueBatchService } from '../../domain/CatalogueBatch.js';
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

export interface CatalogueStampRoutesDeps extends StageRoutesDeps {
  catalogueBatch: Pick<CatalogueBatchService, 'status'>;
}

/**
 * `GET /api/catalogue-stamp`: the brand's catalogue batch, or null while none is designated, and what the next
 * catalogue write does: the batch it is written with, why it is refused, and a move that is waiting. Behind the
 * session. My Streams warns from the second, the Stages page shows the first.
 */
export function createCatalogueStampRouter(deps: CatalogueStampRoutesDeps): Router {
  const { stageService, catalogueBatch, requireAuth } = deps;
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      const [stamp, catalogueWrite] = await Promise.all([stageService.catalogueStamp(), catalogueBatch.status()]);
      const response: CatalogueStampResponse = {
        catalogueStamp: stamp ? toCatalogueStampSummary(stamp) : null,
        catalogueWrite,
      };
      res.json(response);
    }),
  );

  return router;
}
