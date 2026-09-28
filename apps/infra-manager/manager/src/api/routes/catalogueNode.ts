import { Request, Response, Router } from 'express';

import type { CatalogueDesignationService } from '../../domain/stages/CatalogueDesignationService.js';
import {
  type ClearCatalogueNodeBody,
  clearCatalogueNodeSchema,
  type SaveCatalogueNodeBody,
  saveCatalogueNodeSchema,
} from '../../schemas/managerSettings.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { signedInUser } from '../middleware/requireSession.js';
import { validateBodyRefusingUnknown } from '../middleware/validate.js';

/**
 * The brand's catalogue node, which the Manager settings page designates: `GET` the designation with the last
 * reading of its batch and how the last push went, `PUT` a deployment and a batch, `DELETE` it. A save and a clear
 * name the revision they read.
 *
 * Mounted after the session gate like every other router here, and behind the same-site check every write passes.
 * The answer is never cached, because another operator's save, and every reading, changes it.
 */
export function createCatalogueNodeRouter(catalogue: CatalogueDesignationService): Router {
  const router = Router();

  router.get(
    '/manager-settings/catalogue-node',
    asyncHandler(async (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await catalogue.read());
    }),
  );

  router.put(
    '/manager-settings/catalogue-node',
    validateBodyRefusingUnknown(saveCatalogueNodeSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { username } = signedInUser(req);
      const body = req.body as SaveCatalogueNodeBody;
      const saved = await catalogue.designate(
        { expectedRevision: body.expectedRevision, profileName: body.profileName, batchId: body.batchId },
        username,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(saved);
    }),
  );

  router.delete(
    '/manager-settings/catalogue-node',
    validateBodyRefusingUnknown(clearCatalogueNodeSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { username } = signedInUser(req);
      const body = req.body as ClearCatalogueNodeBody;
      const cleared = await catalogue.clear({ expectedRevision: body.expectedRevision }, username);
      res.setHeader('Cache-Control', 'no-store');
      res.json(cleared);
    }),
  );

  return router;
}
