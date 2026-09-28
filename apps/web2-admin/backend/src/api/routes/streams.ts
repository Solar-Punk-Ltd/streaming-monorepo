import { STREAM_LIMITS, type Stream, type StreamListResponse } from '@streaming-monorepo/web2-admin-common';
import express, { Request, RequestHandler, Response, Router } from 'express';

import { UnsupportedMediaTypeError } from '../../domain/errors/index.js';
import { IngestService } from '../../domain/IngestService.js';
import { PublishService } from '../../domain/PublishService.js';
import { normaliseThumbnailMime, StreamService } from '../../domain/StreamService.js';
import { StreamInputBody, streamIdParamSchema, streamInputSchema } from '../../schemas/stream.js';
import { THUMBNAIL_MIME_TYPES } from '../../types/index.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { actorOf } from '../middleware/requireAuth.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { toPublishResult, toStream } from '../presenters.js';

export interface StreamRoutesDeps {
  streamService: StreamService;
  publishService: PublishService;
  ingestService: IngestService;
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

export function createStreamsRouter(deps: StreamRoutesDeps): Router {
  const { streamService, publishService, ingestService, requireAuth } = deps;
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      const streams = await streamService.list();
      const response: StreamListResponse = { streams: streams.map(toStream) };
      res.json(response);
    }),
  );

  router.post(
    '/',
    validateBody(streamInputSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const created = await streamService.create(actorOf(req), req.body as StreamInputBody);
      const response: Stream = toStream(created);
      res.status(201).json(response);
    }),
  );

  router.get(
    '/:id',
    validateParams(streamIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const stream = await streamService.get(streamId(req));
      res.json(toStream(stream));
    }),
  );

  router.put(
    '/:id',
    validateParams(streamIdParamSchema),
    validateBody(streamInputSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const updated = await streamService.update(actorOf(req), streamId(req), req.body as StreamInputBody);
      res.json(toStream(updated));
    }),
  );

  router.delete(
    '/:id',
    validateParams(streamIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      await streamService.remove(actorOf(req), streamId(req));
      res.status(204).end();
    }),
  );

  router.put(
    '/:id/thumbnail',
    validateParams(streamIdParamSchema),
    rawImage,
    asyncHandler(async (req: Request, res: Response) => {
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
      const updated = await streamService.setThumbnail(actorOf(req), streamId(req), contentType, body);
      res.json(toStream(updated));
    }),
  );

  router.get(
    '/:id/thumbnail',
    validateParams(streamIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const thumbnail = await streamService.getThumbnail(streamId(req));
      res.type(thumbnail.thumbnail_mime ?? 'application/octet-stream');
      res.send(thumbnail.thumbnail);
    }),
  );

  router.delete(
    '/:id/thumbnail',
    validateParams(streamIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const updated = await streamService.removeThumbnail(actorOf(req), streamId(req));
      res.json(toStream(updated));
    }),
  );

  router.post(
    '/:id/publish',
    validateParams(streamIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const outcome = await publishService.publish(actorOf(req), streamId(req));
      res.json(toPublishResult(outcome));
    }),
  );

  router.post(
    '/:id/unpublish',
    validateParams(streamIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const outcome = await publishService.unpublish(actorOf(req), streamId(req));
      res.json(toPublishResult(outcome));
    }),
  );

  router.get(
    '/:id/ingest',
    validateParams(streamIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await ingestService.detailsFor(streamId(req)));
    }),
  );

  router.post(
    '/:id/ingest/rotate-key',
    validateParams(streamIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await ingestService.rotateKey(actorOf(req), streamId(req)));
    }),
  );

  return router;
}
