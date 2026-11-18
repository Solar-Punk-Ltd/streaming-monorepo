import type {
  ArchiveActionRequest,
  ArchiveBuyChoice,
  ArchiveCurrentResponse,
} from '@streaming-monorepo/web2-admin-common';
import { Request, RequestHandler, Response, Router } from 'express';

import type { ArchiveService } from '../../domain/archive/ArchiveService.js';
import { archiveActionSchema, archiveBuySchema, archiveIdParamSchema } from '../../schemas/archive.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { actorOf } from '../middleware/requireAuth.js';
import { validateBody, validateParams } from '../middleware/validate.js';

export interface ArchiveRoutesDeps {
  archiveService: ArchiveService;
  requireAuth: RequestHandler;
}

/**
 * The archive on the server, which every signed-in user sees and can act on, the archive stamps, and the Archive
 * page. `apps/web2-admin/common/src/archive.ts` specifies each route.
 *
 * - `GET /api/archive` answers the job, or null: the widget reads it every few seconds.
 * - `POST /api/archive/:id/actions` pauses, resumes, waits, confirms a purchase, changes the stamp, cancels, or closes
 *   the widget for the user who asks. 409 with the sentence when the action does not apply now, 404 when the job is
 *   gone.
 * - `GET /api/archive/stamps` answers the archive stamps with their room, the purchases, and what a buy needs.
 * - `POST /api/archive/stamp-purchases` starts a purchase from the Stamps tab, 202; 409 with the sentence when it
 *   cannot. `GET /api/archive/stamp-purchases/:id` answers one.
 * - `POST /api/archive/:id/confirm-purchase` confirms the stamp the archive `:id`, waiting in `awaiting_purchase`,
 *   buys, with the choice, and answers the job; 409 with the sentence when it cannot, `not_now` when `:id` is not the
 *   current archive, `price_moved` with the new cost when the price moved since the dialog priced it.
 * - `GET /api/archive/streams` answers the streams with an archive, for the Archive page.
 *
 * Starting an archive, a stream's options and its listing switch are under the stream: `/api/streams/:id/archive`.
 */
export function createArchiveRouter(deps: ArchiveRoutesDeps): Router {
  const { archiveService, requireAuth } = deps;
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const response: ArchiveCurrentResponse = { archive: await archiveService.current(actorOf(req).userId) };
      res.set('Cache-Control', 'no-store');
      res.json(response);
    }),
  );

  router.get(
    '/stamps',
    asyncHandler(async (_req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      res.json(await archiveService.stamps());
    }),
  );

  router.post(
    '/stamp-purchases',
    validateBody(archiveBuySchema),
    asyncHandler(async (req: Request, res: Response) => {
      res.status(202).json(await archiveService.buy(actorOf(req), req.body as ArchiveBuyChoice));
    }),
  );

  router.get(
    '/stamp-purchases/:id',
    validateParams(archiveIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      res.json(await archiveService.purchase(String(req.params.id)));
    }),
  );

  router.get(
    '/streams',
    asyncHandler(async (_req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      res.json(await archiveService.archivedStreams());
    }),
  );

  router.post(
    '/:id/confirm-purchase',
    validateParams(archiveIdParamSchema),
    validateBody(archiveBuySchema),
    asyncHandler(async (req: Request, res: Response) => {
      const response: ArchiveCurrentResponse = {
        archive: await archiveService.confirmPurchase(
          actorOf(req),
          String(req.params.id),
          req.body as ArchiveBuyChoice,
        ),
      };
      res.json(response);
    }),
  );

  router.post(
    '/:id/actions',
    validateParams(archiveIdParamSchema),
    validateBody(archiveActionSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const response: ArchiveCurrentResponse = {
        archive: await archiveService.act(actorOf(req), String(req.params.id), req.body as ArchiveActionRequest),
      };
      res.json(response);
    }),
  );

  return router;
}
