import type {
  IngestLookupResponse,
  MediaType,
  RenditionReport,
  RenditionReportResponse,
  StreamStateResponse,
} from '@streaming-monorepo/web2-admin-common';
import { Request, RequestHandler, Response, Router } from 'express';

import { LadderService } from '../../domain/LadderService.js';
import { StreamStateService } from '../../domain/StreamStateService.js';
import {
  ingestLookupParamSchema,
  renditionReportSchema,
  streamStateSchema,
  type StreamStateBody,
} from '../../schemas/internal.js';
import { streamIdParamSchema } from '../../schemas/stream.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import {
  toIngestLookup,
  toPublishResult,
  toRenditionReportResponse,
} from '../presenters.js';

export interface InternalRoutesDeps {
  streamStateService: StreamStateService;
  ladderService: LadderService;
  requireInternalToken: RequestHandler;
}

/**
 * What the swarm-hls-stream uploader calls, and nothing else. Three routes: the
 * one that turns an ingest address into the draft an encoder is publishing to,
 * the one that reports what happened to it, and the one that reports a rung of
 * its ABR ladder.
 *
 * The split with the console's routes is the whole point of the checkpoint.
 * The uploader owns each stream's manifest feeds and never writes the
 * catalogue; the admin API owns the catalogue and never touches a manifest.
 * `POST /state` and `POST /renditions` are how the one tells the other what to
 * say.
 */
export function createInternalRouter(deps: InternalRoutesDeps): Router {
  const { streamStateService, ladderService, requireInternalToken } = deps;
  const router = Router();

  router.use(requireInternalToken);

  router.get(
    '/streams/by-ingest/:app/:stream',
    validateParams(ingestLookupParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const stream = await streamStateService.lookupByIngest(
        String(req.params.app) as MediaType,
        String(req.params.stream),
      );
      const response: IngestLookupResponse = toIngestLookup(stream);
      res.json(response);
    }),
  );

  router.post(
    '/streams/:id/state',
    validateParams(streamIdParamSchema),
    validateBody(streamStateSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const outcome = await streamStateService.report(
        String(req.params.id),
        req.body as StreamStateBody,
      );
      const response: StreamStateResponse = toPublishResult(outcome);
      res.json(response);
    }),
  );

  router.post(
    '/streams/:id/renditions',
    validateParams(streamIdParamSchema),
    validateBody(renditionReportSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const outcome = await ladderService.report(
        String(req.params.id),
        req.body as RenditionReport,
      );
      const response: RenditionReportResponse =
        toRenditionReportResponse(outcome);
      res.json(response);
    }),
  );

  return router;
}
