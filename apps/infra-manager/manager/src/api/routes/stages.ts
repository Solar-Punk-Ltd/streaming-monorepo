import { Request, Response, Router } from 'express';

import type { ConsoleStagesAnswer, StageRegistrationAnswer } from '@streaming-infra-manager/common';

import type { StagePublisher } from '../../domain/stages/StagePublisher.js';
import { profileNameSchema } from '../../schemas/profile.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateParams } from '../middleware/validate.js';

/**
 * The stages the manager pushes into the web2 admin, for its own console, behind the session like every router
 * here. `GET /stages` builds every record the manager would push now, reading each stage's nodes and uploader, and
 * leaves out the SRT passphrase. `GET /stages/:name/registration` answers one deployment's last push from memory,
 * which the deployment page asks on a cadence.
 */
export function createStagesRouter(publisher: Pick<StagePublisher, 'consoleStages' | 'lastPush'>): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      const answer: ConsoleStagesAnswer = { stages: await publisher.consoleStages() };
      res.setHeader('Cache-Control', 'no-store');
      res.json(answer);
    }),
  );

  router.get(
    '/:name/registration',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const answer: StageRegistrationAnswer = { registration: publisher.lastPush(req.params.name as string) };
      res.setHeader('Cache-Control', 'no-store');
      res.json(answer);
    }),
  );

  return router;
}
