import { Request, Response, Router } from 'express';

import type { ArchiveBatchService } from '../../domain/stages/ArchiveBatchService.js';
import {
  type AdoptArchiveBatchBody,
  adoptArchiveBatchSchema,
  archiveBatchParamsSchema,
  type RemoveArchiveBatchBody,
  removeArchiveBatchSchema,
} from '../../schemas/managerSettings.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { signedInUser } from '../middleware/requireSession.js';
import { validateBodyRefusingUnknown, validateParams } from '../middleware/validate.js';

/**
 * The brand's archive batches on the Manager settings page: `GET` them with their last readings and the other
 * batches the catalogue node holds, `PUT .../:batchId` to adopt one of those, and `DELETE .../:batchId` to take an
 * expired one off the list. An adopt and a removal name the revision they read. The routes are specified in
 * `common/src/archiveBatches.ts`.
 *
 * Mounted after the session gate like every other router here, and behind the same-site check every write passes.
 * The answer is never cached, because another operator's change, and every reading, changes it.
 */
export function createArchiveBatchesRouter(archive: ArchiveBatchService): Router {
  const router = Router();

  router.get(
    '/manager-settings/archive-batches',
    asyncHandler(async (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await archive.read());
    }),
  );

  router.put(
    '/manager-settings/archive-batches/:batchId',
    validateParams(archiveBatchParamsSchema),
    validateBodyRefusingUnknown(adoptArchiveBatchSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { username } = signedInUser(req);
      const body = req.body as AdoptArchiveBatchBody;
      const answer = await archive.adopt(
        req.params.batchId as string,
        { expectedRevision: body.expectedRevision, label: body.label ?? null },
        username,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(answer);
    }),
  );

  router.delete(
    '/manager-settings/archive-batches/:batchId',
    validateParams(archiveBatchParamsSchema),
    validateBodyRefusingUnknown(removeArchiveBatchSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { username } = signedInUser(req);
      const body = req.body as RemoveArchiveBatchBody;
      const answer = await archive.remove(
        req.params.batchId as string,
        { expectedRevision: body.expectedRevision },
        username,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(answer);
    }),
  );

  return router;
}
