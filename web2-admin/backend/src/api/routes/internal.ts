import type {
  IngestLookupResponse,
  ContinuationPreparationRequest,
  ManagedClaimRequest,
  ManagedRunReport,
  MediaType,
  RenditionReport,
  RenditionReportResponse,
  StreamStateResponse,
  UploaderCapabilities,
} from '@streaming-monorepo/web2-admin-common';
import { Request, RequestHandler, Response, Router } from 'express';

import { LadderService } from '../../domain/LadderService.js';
import { ContinuationRepository } from '../../domain/ContinuationRepository.js';
import { ManagedLifecycleRepository } from '../../domain/ManagedLifecycleRepository.js';
import { PublishService } from '../../domain/PublishService.js';
import { StreamStateService } from '../../domain/StreamStateService.js';
import { UploaderCapabilityRepository } from '../../domain/UploaderCapabilityRepository.js';
import {
  ingestLookupParamSchema,
  continuationPreparationParamSchema,
  continuationPreparationSchema,
  managedClaimSchema,
  managedRunIdentitySchema,
  managedRunParamSchema,
  managedReportSchema,
  renditionReportSchema,
  streamStateSchema,
  uploaderContinuationParamSchema,
  uploaderCapabilitySchema,
  type StreamStateBody,
} from '../../schemas/internal.js';
import { streamIdParamSchema } from '../../schemas/stream.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  validateBody,
  validateParams,
  validateQuery,
} from '../middleware/validate.js';
import {
  toIngestLookup,
  toPublishResult,
  toRenditionReportResponse,
} from '../presenters.js';

export interface InternalRoutesDeps {
  streamStateService: StreamStateService;
  ladderService: LadderService;
  managedLifecycle: ManagedLifecycleRepository;
  continuations: ContinuationRepository;
  publishService: PublishService;
  uploaderCapabilities?: UploaderCapabilityRepository;
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
  const {
    streamStateService,
    ladderService,
    managedLifecycle,
    continuations,
    publishService,
    uploaderCapabilities,
    requireInternalToken,
  } = deps;
  const router = Router();

  router.use(requireInternalToken);

  if (uploaderCapabilities) {
    router.post(
      '/uploaders/:uploaderId/capabilities',
      validateParams(uploaderContinuationParamSchema),
      validateBody(uploaderCapabilitySchema),
      asyncHandler(async (req: Request, res: Response) => {
        const receipt = await uploaderCapabilities.record(
          String(req.params.uploaderId),
          req.body as UploaderCapabilities,
        );
        res.json(receipt);
      }),
    );
  }

  router.get(
    '/uploaders/:uploaderId/continuations',
    validateParams(uploaderContinuationParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const operations = await continuations.listPending(
        String(req.params.uploaderId),
      );
      res.json({ continuations: operations });
    }),
  );

  router.post(
    '/streams/:id/continuations/:operationId/preparation',
    validateParams(continuationPreparationParamSchema),
    validateBody(continuationPreparationSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const operation = await continuations.prepare(
        String(req.params.id),
        String(req.params.operationId),
        req.body as ContinuationPreparationRequest,
      );
      await publishService.republishManagedState(String(req.params.id));
      res.json({ operation });
    }),
  );

  router.get(
    '/streams/by-ingest/:app/:stream',
    validateParams(ingestLookupParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const stream = await streamStateService.lookupByIngest(
        String(req.params.app) as MediaType,
        String(req.params.stream),
        req.header('X-Stream-Lifecycle-Version'),
      );
      const expectedRenditions =
        stream.lifecycle_version === 1 && stream.current_run_number !== null
          ? await managedLifecycle.expectedRenditions(
              stream.id,
              stream.current_run_number,
            )
          : [];
      const response: IngestLookupResponse = toIngestLookup(
        stream,
        req.header('X-Stream-Lifecycle-Version') === '1',
        expectedRenditions,
      );
      res.json(response);
    }),
  );

  router.post(
    '/streams/:id/runs/:run/reports',
    validateParams(managedRunParamSchema),
    validateBody(managedReportSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const run = await managedLifecycle.report(
        String(req.params.id),
        Number(req.params.run),
        req.body as ManagedRunReport,
      );
      await publishService.republishManagedState(String(req.params.id));
      res.json(run);
    }),
  );

  router.post(
    '/streams/:id/runs/:run/claims',
    validateParams(managedRunParamSchema),
    validateBody(managedClaimSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const run = await managedLifecycle.claim(
        String(req.params.id),
        Number(req.params.run),
        req.body as ManagedClaimRequest,
      );
      await publishService.republishManagedState(String(req.params.id));
      res.json(run);
    }),
  );

  router.get(
    '/streams/:id/runs/:run',
    validateParams(managedRunParamSchema),
    validateQuery(managedRunIdentitySchema),
    asyncHandler(async (req: Request, res: Response) => {
      const run = await managedLifecycle.readClaimedRun(
        String(req.params.id),
        Number(req.params.run),
        req.query.uploaderId as string,
        req.query.claimId as string,
      );
      res.json(run);
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
