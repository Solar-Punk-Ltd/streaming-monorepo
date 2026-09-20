import {
  type ContinuationCreateRequest,
  type ContinuationOperation,
  STREAM_LIMITS,
  type Stream,
  type StreamListResponse,
} from '@streaming-monorepo/web2-admin-common';
import express, { Request, RequestHandler, Response, Router } from 'express';

import { UnsupportedMediaTypeError } from '../../domain/errors/index.js';
import { ContinuationRepository } from '../../domain/ContinuationRepository.js';
import { IngestService } from '../../domain/IngestService.js';
import { PublishService } from '../../domain/PublishService.js';
import {
  normaliseThumbnailMime,
  StreamService,
} from '../../domain/StreamService.js';
import {
  StreamInputBody,
  continuationCreateSchema,
  continuationOperationParamSchema,
  streamIdParamSchema,
  streamInputSchema,
} from '../../schemas/stream.js';
import { THUMBNAIL_MIME_TYPES } from '../../types/index.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireUser } from '../middleware/requireAuth.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { toPublishResult, toStream } from '../presenters.js';

export interface StreamRoutesDeps {
  streamService: StreamService;
  publishService: PublishService;
  ingestService: IngestService;
  continuations: ContinuationRepository;
  requireAuth: RequestHandler;
}

/**
 * Thumbnails arrive as a raw image body rather than multipart: one image per
 * stream, no other fields, so multipart would only add a dependency. Bodies
 * over the limit are rejected by body-parser with a 413 (see errorHandler); a
 * body that is not an image at all never matches `type` here and is refused as
 * 415 by the handler.
 */
const rawImage = express.raw({
  type: 'image/*',
  limit: STREAM_LIMITS.THUMBNAIL_MAX_BYTES,
});

/**
 * The `:id` of the current request. `validateParams(streamIdParamSchema)` has
 * already established that it is a UUID; this only narrows the Express 5
 * `string | string[]` param type.
 */
function streamId(req: Request): string {
  return String(req.params.id);
}

export function toOwnerContinuation(operation: ContinuationOperation) {
  const {
    retainedRecording: _retainedRecording,
    previousEmptyOutcome: _previousEmptyOutcome,
    uploaderId: _uploaderId,
    ...ownerOperation
  } = operation;
  return ownerOperation;
}

export function createStreamsRouter(deps: StreamRoutesDeps): Router {
  const {
    streamService,
    publishService,
    ingestService,
    continuations,
    requireAuth,
  } = deps;
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = requireUser(req);
      const streams = await streamService.list(user.id);
      const response: StreamListResponse = { streams: streams.map(toStream) };
      res.json(response);
    }),
  );

  router.post(
    '/:id/continuations',
    validateParams(streamIdParamSchema),
    validateBody(continuationCreateSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = requireUser(req);
      const operation = await continuations.create(
        streamId(req),
        user.id,
        req.body as ContinuationCreateRequest,
      );
      await publishService.republishManagedState(streamId(req));
      const location = `/api/streams/${streamId(req)}/continuations/${operation.operationId}`;
      res.location(location).status(202).json({
        operation: toOwnerContinuation(operation),
      });
    }),
  );

  router.get(
    '/:id/continuations/:operationId',
    validateParams(continuationOperationParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = requireUser(req);
      const operation = await continuations.get(
        streamId(req),
        String(req.params.operationId),
        user.id,
      );
      res.json({ operation: toOwnerContinuation(operation) });
    }),
  );

  router.delete(
    '/:id/continuations/:operationId',
    validateParams(continuationOperationParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = requireUser(req);
      const operation = await continuations.cancel(
        streamId(req),
        String(req.params.operationId),
        user.id,
      );
      await publishService.republishManagedState(streamId(req));
      res.json({ operation: toOwnerContinuation(operation) });
    }),
  );

  router.post(
    '/',
    validateBody(streamInputSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = requireUser(req);
      const created = await streamService.create(
        user.id,
        req.body as StreamInputBody,
      );
      const response: Stream = toStream(created);
      res.status(201).json(response);
    }),
  );

  router.get(
    '/:id',
    validateParams(streamIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = requireUser(req);
      const stream = await streamService.get(streamId(req), user.id);
      const managed = await streamService.managedOwnerState(stream.id);
      res.json(toStream(stream, managed));
    }),
  );

  router.put(
    '/:id',
    validateParams(streamIdParamSchema),
    validateBody(streamInputSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = requireUser(req);
      const updated = await streamService.update(
        streamId(req),
        user.id,
        req.body as StreamInputBody,
      );
      res.json(toStream(updated));
    }),
  );

  router.delete(
    '/:id',
    validateParams(streamIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = requireUser(req);
      await streamService.remove(streamId(req), user.id);
      res.status(204).end();
    }),
  );

  router.put(
    '/:id/thumbnail',
    validateParams(streamIdParamSchema),
    rawImage,
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = requireUser(req);
      const contentType = req.headers['content-type'] ?? '';
      const mime = normaliseThumbnailMime(contentType);
      if (!THUMBNAIL_MIME_TYPES.includes(mime)) {
        // A body express.raw did not match is left untouched, so this has to
        // be checked before looking at it.
        throw new UnsupportedMediaTypeError(contentType, THUMBNAIL_MIME_TYPES);
      }
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({
          error: 'validation_error',
          errors: ['thumbnail body is empty'],
        });
        return;
      }
      const updated = await streamService.setThumbnail(
        streamId(req),
        user.id,
        contentType,
        body,
      );
      res.json(toStream(updated));
    }),
  );

  router.get(
    '/:id/thumbnail',
    validateParams(streamIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = requireUser(req);
      const thumbnail = await streamService.getThumbnail(
        streamId(req),
        user.id,
      );
      res.type(thumbnail.thumbnail_mime ?? 'application/octet-stream');
      res.send(thumbnail.thumbnail);
    }),
  );

  router.delete(
    '/:id/thumbnail',
    validateParams(streamIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = requireUser(req);
      const updated = await streamService.removeThumbnail(
        streamId(req),
        user.id,
      );
      res.json(toStream(updated));
    }),
  );

  router.post(
    '/:id/publish',
    validateParams(streamIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = requireUser(req);
      const outcome = await publishService.publish(streamId(req), user.id);
      res.json(toPublishResult(outcome));
    }),
  );

  router.post(
    '/:id/unpublish',
    validateParams(streamIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = requireUser(req);
      const outcome = await publishService.unpublish(streamId(req), user.id);
      res.json(toPublishResult(outcome));
    }),
  );

  router.get(
    '/:id/ingest',
    validateParams(streamIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = requireUser(req);
      res.json(await ingestService.detailsFor(streamId(req), user.id));
    }),
  );

  router.post(
    '/:id/ingest/rotate-key',
    validateParams(streamIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { user } = requireUser(req);
      res.json(await ingestService.rotateKey(streamId(req), user.id));
    }),
  );

  return router;
}
