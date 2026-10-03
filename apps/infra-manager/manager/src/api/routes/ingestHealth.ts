import { Request, Response, Router } from 'express';

import { IngestHealthService } from '../../domain/ingestHealth/IngestHealthService.js';
import { profileNameSchema } from '../../schemas/profile.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateParams } from '../middleware/validate.js';

/**
 * How one deployment's ingest is holding up, from SRS's own statistics.
 *
 * One deployment at a time and never on a list, because every answer reads
 * the engine's log. The answer is numbers and states. The log it was worked
 * out from never reaches this router.
 */
export function createIngestHealthRouter(ingestHealth: IngestHealthService): Router {
  const router = Router();

  router.get(
    '/:name/ingest-health',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await ingestHealth.read(req.params.name as string));
    }),
  );

  return router;
}
