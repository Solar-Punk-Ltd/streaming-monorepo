import type {
  IngestLookupResponse,
  MediaType,
  RenditionReport,
  RenditionReportResponse,
  StreamStateResponse,
} from '@streaming-monorepo/web2-admin-common';
import {
  catalogueStampClearRequestSchema,
  catalogueStampRecordSchema,
  ingestLookupParamsSchema,
  renditionReportSchema,
  stageRecordSchema,
  stageRetireRequestSchema,
  type CatalogueStampClearAnswer,
  type CatalogueStampClearRequest,
  type CatalogueStampRecord,
  type StageRecord,
  type StageRetireAnswer,
  type StageRetireRequest,
  type StageSelfAnswer,
  type StageStoreAnswer,
  type StreamStateReport,
  streamStateReportSchema,
} from '@streaming-monorepo/contracts';
import { Request, RequestHandler, Response, Router } from 'express';

import { RequestShapeError } from '../../domain/errors/index.js';
import { LadderService } from '../../domain/LadderService.js';
import { StageService } from '../../domain/StageService.js';
import { StreamStateService } from '../../domain/StreamStateService.js';
import { scopeOf } from '../../domain/uploaderScope.js';
import { stageIdParamSchema } from '../../schemas/stage.js';
import { streamIdParamSchema } from '../../schemas/stream.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { notFound } from '../middleware/notFound.js';
import { uploaderCallerOf } from '../middleware/requireUploaderToken.js';
import { validateContractBody, validateContractParams, validateParams } from '../middleware/validate.js';
import { toIngestLookup, toPublishResult, toRenditionReportResponse } from '../presenters.js';

export interface InternalRoutesDeps {
  streamStateService: StreamStateService;
  ladderService: LadderService;
  stageService: StageService;
  /** The manager's door: the registrar token, `INTERNAL_API_TOKEN`, alone. */
  requireRegistrarToken: RequestHandler;
  /** The uploader's door: a stage's own token, or the shared one as an unattributed caller. */
  requireUploaderToken: RequestHandler;
}

/** The `:stageId` of the request in lower case, as the contract keeps a stage id. The param schema checked it. */
function stageIdOf(req: Request): string {
  return String(req.params.stageId).toLowerCase();
}

/**
 * What the admin's machine callers call, and nothing else.
 *
 * The swarm-hls-stream uploader has four routes: the one that turns an
 * ingest address into the draft an encoder is publishing to, the one that
 * reports what happened to it, the one that reports a rung of its ABR
 * ladder, and the one that says which stage its token is on. The split with the console's routes is the whole point of the
 * checkpoint. The uploader owns each stream's manifest feeds and never writes
 * the catalogue; the admin API owns the catalogue and never touches a
 * manifest. `POST /state` and `POST /renditions` are how the one tells the
 * other what to say.
 *
 * The manager has four: it pushes each stage's record and the brand's
 * catalogue stamp record, and takes them back (docs/architecture/stages.md).
 *
 * Each route names its door. The manager's take the registrar token,
 * `INTERNAL_API_TOKEN`, and nothing else: a stage's own token is refused
 * there. The uploader's take a stage's own token, and are then answered only
 * about that stage's streams, or the shared `INTERNAL_API_TOKEN` while the
 * stages move over, unattributed and answered about every stream as before.
 * A path
 * or method no route names answers 401 without either token and 404 with
 * one, as it did when one token opened the whole router.
 */
export function createInternalRouter(deps: InternalRoutesDeps): Router {
  const { streamStateService, ladderService, stageService, requireRegistrarToken, requireUploaderToken } = deps;
  const router = Router();

  // Ahead of `/stages/:stageId`, although only PUT and DELETE take that one, and only with a UUID: `self` is never
  // a stage id.
  router.get('/stages/self', requireUploaderToken, (req: Request, res: Response) => {
    const caller = uploaderCallerOf(req);
    if (caller.kind !== 'stage') {
      // A caller on the shared token belongs to no stage. It is answered as an admin without this route answers,
      // so the uploader falls back to the same check either way.
      notFound(req, res);
      return;
    }
    const response: StageSelfAnswer = { stageId: caller.stageId, owner: caller.owner };
    res.json(response);
  });

  router.put(
    '/stages/:stageId',
    requireRegistrarToken,
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
    requireRegistrarToken,
    validateParams(stageIdParamSchema),
    validateContractBody(stageRetireRequestSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { observedAt } = req.body as StageRetireRequest;
      const response: StageRetireAnswer = await stageService.retire(stageIdOf(req), observedAt);
      res.json(response);
    }),
  );

  router.put(
    '/catalogue-stamp',
    requireRegistrarToken,
    validateContractBody(catalogueStampRecordSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const response: StageStoreAnswer = await stageService.storeCatalogueStamp(req.body as CatalogueStampRecord);
      res.json(response);
    }),
  );

  router.delete(
    '/catalogue-stamp',
    requireRegistrarToken,
    validateContractBody(catalogueStampClearRequestSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { observedAt } = req.body as CatalogueStampClearRequest;
      const response: CatalogueStampClearAnswer = await stageService.clearCatalogueStamp(observedAt);
      res.json(response);
    }),
  );

  router.get(
    '/streams/by-ingest/:app/:stream',
    requireUploaderToken,
    validateContractParams(ingestLookupParamsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const stream = await streamStateService.lookupByIngest(
        String(req.params.app) as MediaType,
        String(req.params.stream),
        scopeOf(uploaderCallerOf(req)),
      );
      const response: IngestLookupResponse = toIngestLookup(stream);
      res.json(response);
    }),
  );

  router.post(
    '/streams/:id/state',
    requireUploaderToken,
    validateParams(streamIdParamSchema),
    validateContractBody(streamStateReportSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const outcome = await streamStateService.report(
        String(req.params.id),
        req.body as StreamStateReport,
        scopeOf(uploaderCallerOf(req)),
      );
      const response: StreamStateResponse = toPublishResult(outcome);
      res.json(response);
    }),
  );

  router.post(
    '/streams/:id/renditions',
    requireUploaderToken,
    validateParams(streamIdParamSchema),
    validateContractBody(renditionReportSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const outcome = await ladderService.report(
        String(req.params.id),
        req.body as RenditionReport,
        scopeOf(uploaderCallerOf(req)),
      );
      const response: RenditionReportResponse = toRenditionReportResponse(outcome);
      res.json(response);
    }),
  );

  // Anything else under /api/internal: 401 without a token either door takes, and then on to the 404 every
  // unknown path gets. The uploader's door takes both the shared token and a stage's own.
  router.use(requireUploaderToken);

  return router;
}
