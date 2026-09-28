import type {
  CatalogueMoveStatus,
  CatalogueStampResponse,
  StageListResponse,
} from '@streaming-monorepo/web2-admin-common';
import { Request, RequestHandler, Response, Router } from 'express';

import type { CatalogueBatchService } from '../../domain/CatalogueBatch.js';
import type { CatalogueMoveService } from '../../domain/CatalogueMove.js';
import { StageService } from '../../domain/StageService.js';
import { type CatalogueMoveBody, catalogueMoveBodySchema } from '../../schemas/stage.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { actorOf } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validate.js';
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
  catalogueMove: Pick<CatalogueMoveService, 'status' | 'start'>;
}

/**
 * `GET /api/catalogue-stamp`: the brand's catalogue batch, or null while none is designated, what the next catalogue
 * write does (the batch it is written with, why it is refused, and a move that is waiting) and the move of the
 * catalogue's history: whether one waits, can start, runs or finished. Behind the session. My Streams warns from the
 * second, the Stages page shows the first and the third.
 *
 * `POST /api/catalogue-stamp/move` starts the move to the batch its body names, which must be the designated one, or
 * retries a failed one, and answers the move's status. 409 with the sentence when it cannot start. Behind the session
 * and the same-site check, like every console write.
 */
export function createCatalogueStampRouter(deps: CatalogueStampRoutesDeps): Router {
  const { stageService, catalogueBatch, catalogueMove, requireAuth } = deps;
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      const [stamp, catalogueWrite, move] = await Promise.all([
        stageService.catalogueStamp(),
        catalogueBatch.status(),
        catalogueMove.status(),
      ]);
      const response: CatalogueStampResponse = {
        catalogueStamp: stamp ? toCatalogueStampSummary(stamp) : null,
        catalogueWrite,
        catalogueMove: move,
      };
      res.json(response);
    }),
  );

  router.post(
    '/move',
    validateBody(catalogueMoveBodySchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as CatalogueMoveBody;
      const status: CatalogueMoveStatus = await catalogueMove.start(actorOf(req), body.targetBatchId);
      res.status(202).json(status);
    }),
  );

  return router;
}
