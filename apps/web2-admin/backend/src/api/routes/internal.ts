import type {
  IngestLookupResponse,
  MediaType,
  RenditionReport,
  RenditionReportResponse,
  StreamStateResponse,
} from '@streaming-monorepo/web2-admin-common';
import {
  catalogueStampRecordSchema,
  ingestLookupParamsSchema,
  renditionReportSchema,
  stageRecordSchema,
  type CatalogueStampRecord,
  type StageRecord,
  type StageRetireAnswer,
  type StageStoreAnswer,
  type StreamStateReport,
  streamStateReportSchema,
} from '@streaming-monorepo/contracts';
import { Request, RequestHandler, Response, Router } from 'express';

import { RequestShapeError } from '../../domain/errors/index.js';
import { LadderService } from '../../domain/LadderService.js';
import { StageService } from '../../domain/StageService.js';
import { StreamStateService } from '../../domain/StreamStateService.js';
import { stageIdParamSchema } from '../../schemas/stage.js';
import { streamIdParamSchema } from '../../schemas/stream.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateContractBody, validateContractParams, validateParams } from '../middleware/validate.js';
import { toIngestLookup, toPublishResult, toRenditionReportResponse } from '../presenters.js';

export interface InternalRoutesDeps {
  streamStateService: StreamStateService;
  ladderService: LadderService;
  stageService: StageService;
  requireInternalToken: RequestHandler;
}

/** The `:stageId` of the request in lower case, as the contract keeps a stage id. The param schema checked it. */
function stageIdOf(req: Request): string {
  return String(req.params.stageId).toLowerCase();
}

/**
 * What the admin's machine callers call, and nothing else.
 *
 * The swarm-hls-stream uploader has three routes: the one that turns an
 * ingest address into the draft an encoder is publishing to, the one that
 * reports what happened to it, and the one that reports a rung of its ABR
 * ladder. The split with the console's routes is the whole point of the
 * checkpoint. The uploader owns each stream's manifest feeds and never writes
 * the catalogue; the admin API owns the catalogue and never touches a
 * manifest. `POST /state` and `POST /renditions` are how the one tells the
 * other what to say.
 *
 * The manager has four: it pushes each stage's record and the brand's
 * catalogue stamp record, and takes them back (docs/architecture/stages.md).
 * It presents the registrar token, which is still the one
 * `INTERNAL_API_TOKEN` every caller here shares.
 */
export function createInternalRouter(deps: InternalRoutesDeps): Router {
  const { streamStateService, ladderService, stageService, requireInternalToken } = deps;
  const router = Router();

  router.use(requireInternalToken);

  router.put(
    '/stages/:stageId',
    validateParams(stageIdParamSchema),
    validateContractBody(stageRecordSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const record = req.body as StageRecord;
      if (stageIdOf(req) !== record.stageId) {
        throw new RequestShapeError(['the stage id in the path must equal stageId in the body']);
      }
      const response: StageStoreAnswer = await stageService.store(record);
      res.json(response);
    }),
  );

  router.delete(
    '/stages/:stageId',
    validateParams(stageIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const response: StageRetireAnswer = await stageService.retire(stageIdOf(req));
      res.json(response);
    }),
  );

  router.put(
    '/catalogue-stamp',
    validateContractBody(catalogueStampRecordSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const response: StageStoreAnswer = await stageService.storeCatalogueStamp(req.body as CatalogueStampRecord);
      res.json(response);
    }),
  );

  router.delete(
    '/catalogue-stamp',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await stageService.clearCatalogueStamp());
    }),
  );

  router.get(
    '/streams/by-ingest/:app/:stream',
    validateContractParams(ingestLookupParamsSchema),
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
    validateContractBody(streamStateReportSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const outcome = await streamStateService.report(String(req.params.id), req.body as StreamStateReport);
      const response: StreamStateResponse = toPublishResult(outcome);
      res.json(response);
    }),
  );

  router.post(
    '/streams/:id/renditions',
    validateParams(streamIdParamSchema),
    validateContractBody(renditionReportSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const outcome = await ladderService.report(String(req.params.id), req.body as RenditionReport);
      const response: RenditionReportResponse = toRenditionReportResponse(outcome);
      res.json(response);
    }),
  );

  return router;
}
