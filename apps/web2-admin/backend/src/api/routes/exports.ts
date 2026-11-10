import type { ExportActionRequest, ExportCurrentResponse } from '@streaming-monorepo/web2-admin-common';
import { Request, RequestHandler, Response, Router } from 'express';

import type { ExportService } from '../../domain/export/ExportService.js';
import { Logger } from '../../domain/Logger.js';
import { exportActionSchema, exportIdParamSchema } from '../../schemas/export.js';
import { getErrorMessage } from '../../utils/errorUtils.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { actorOf } from '../middleware/requireAuth.js';
import { validateBody, validateParams } from '../middleware/validate.js';

const logger = Logger.getInstance();

export interface ExportRoutesDeps {
  exportService: ExportService;
  requireAuth: RequestHandler;
}

/**
 * The export on the server, which every signed-in user sees and can act on.
 *
 * - `GET /api/export` answers it, or null: the widget reads it every few seconds.
 * - `POST /api/export/:id/actions` pauses, resumes, waits, saves what was read, cancels, or closes the widget for the
 *   user who asks. 409 with the sentence when the export is in a state the action does not apply to, 404 when the
 *   export is gone.
 * - `GET /api/export/:id/file` sends the finished MP4 as an attachment under its file name, with ranges, so a browser
 *   can resume a download. A plain GET, so a link saves it; reads are never refused by the cross-site gate.
 *   `X-Accel-Buffering: no` lets the console's nginx pass it on as it comes rather than buffering gigabytes.
 *
 * Starting an export, and the options it starts from, are under the stream: `/api/streams/:id/export`.
 */
export function createExportRouter(deps: ExportRoutesDeps): Router {
  const { exportService, requireAuth } = deps;
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const response: ExportCurrentResponse = { export: await exportService.current(actorOf(req).userId) };
      res.set('Cache-Control', 'no-store');
      res.json(response);
    }),
  );

  router.post(
    '/:id/actions',
    validateParams(exportIdParamSchema),
    validateBody(exportActionSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { action } = req.body as ExportActionRequest;
      const response: ExportCurrentResponse = {
        export: await exportService.act(actorOf(req), String(req.params.id), action),
      };
      res.json(response);
    }),
  );

  router.get(
    '/:id/file',
    validateParams(exportIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const file = await exportService.file(id);
      // A resumed download asks for the rest; only a request from the start is a save.
      const range = req.headers.range;
      if (!range || range.startsWith('bytes=0-')) await exportService.recordSaved(actorOf(req), id);
      await new Promise<void>((resolve, reject) => {
        res.download(
          file.path,
          file.fileName,
          { headers: { 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } },
          (error) => {
            if (!error) {
              resolve();
            } else if (res.headersSent) {
              // The browser stopped the download, or the connection dropped: nothing to answer any more.
              logger.debug(`[Export] a download of ${file.fileName} stopped: ${getErrorMessage(error)}`);
              resolve();
            } else {
              reject(error);
            }
          },
        );
      });
    }),
  );

  return router;
}
