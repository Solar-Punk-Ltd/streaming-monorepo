import { NextFunction, Request, Response } from 'express';
import { ValidationError as YupValidationError } from 'yup';

import {
  FeedOwnerMismatchError,
  InvalidCredentialsError,
  InvalidPasswordError,
  InvalidStateError,
  InvalidStateTransitionError,
  MediaTypeLockedError,
  PublishFailedError,
  StreamBusyError,
  StreamLiveError,
  StreamLockedError,
  StreamNotFoundError,
  StreamPublishedError,
  ThumbnailNotFoundError,
  TooManyAttemptsError,
  UnauthenticatedError,
  UnsupportedMediaTypeError,
} from '../../domain/errors/index.js';
import { Logger } from '../../domain/Logger.js';
import { getErrorMessage, getErrorStack } from '../../utils/errorUtils.js';

const logger = Logger.getInstance();

/** body-parser rejections carry a `type` and a `status`; map the two we can hit. */
function bodyParserType(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const type = (err as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

/**
 * Centralised error → HTTP mapping. Domain errors get specific status codes;
 * everything else becomes a 500 with the message logged but not echoed back.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    // Something already started writing — a streamed thumbnail, say. Nothing
    // useful can be said in the body now; hand it back so Express closes the
    // connection instead of throwing ERR_HTTP_HEADERS_SENT over the real error.
    next(err);
    return;
  }
  if (err instanceof YupValidationError) {
    res.status(400).json({ error: 'validation_error', errors: err.errors });
    return;
  }
  if (err instanceof UnauthenticatedError) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (err instanceof InvalidCredentialsError) {
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }
  if (err instanceof TooManyAttemptsError) {
    res.setHeader('Retry-After', String(err.retryAfterSeconds));
    res.status(429).json({ error: 'too_many_attempts' });
    return;
  }
  if (err instanceof InvalidPasswordError) {
    res.status(400).json({ error: 'invalid_password' });
    return;
  }
  if (err instanceof StreamNotFoundError) {
    res.status(404).json({ error: 'stream_not_found', id: err.streamId });
    return;
  }
  if (err instanceof ThumbnailNotFoundError) {
    res.status(404).json({ error: 'thumbnail_not_found', id: err.streamId });
    return;
  }
  if (err instanceof StreamBusyError) {
    res.status(409).json({
      error: 'stream_busy',
      id: err.streamId,
      status: err.currentStatus,
    });
    return;
  }
  if (err instanceof StreamPublishedError) {
    res.status(409).json({
      error: 'stream_published',
      id: err.streamId,
      status: err.currentStatus,
    });
    return;
  }
  if (err instanceof StreamLiveError) {
    res.status(409).json({
      error: 'stream_live',
      id: err.streamId,
      message: err.message,
    });
    return;
  }
  if (err instanceof StreamLockedError) {
    res.status(409).json({
      error: 'stream_locked',
      id: err.streamId,
      field: err.field,
      message: err.message,
    });
    return;
  }
  if (err instanceof InvalidStateError) {
    res.status(409).json({
      error: 'invalid_state',
      id: err.streamId,
      status: err.currentStatus,
    });
    return;
  }
  if (err instanceof InvalidStateTransitionError) {
    res.status(409).json({
      error: 'invalid_state_transition',
      from: err.from,
      to: err.to,
    });
    return;
  }
  if (err instanceof FeedOwnerMismatchError) {
    res
      .status(409)
      .json({ error: 'feed_owner_mismatch', message: err.message });
    return;
  }
  if (err instanceof MediaTypeLockedError) {
    res.status(409).json({ error: 'media_type_locked', message: err.message });
    return;
  }
  if (err instanceof UnsupportedMediaTypeError) {
    res
      .status(415)
      .json({ error: 'unsupported_media_type', message: err.message });
    return;
  }
  if (err instanceof PublishFailedError) {
    res
      .status(502)
      .json({ error: 'publish_failed', id: err.streamId, message: err.reason });
    return;
  }

  const parserType = bodyParserType(err);
  if (parserType === 'entity.too.large') {
    res.status(413).json({ error: 'payload_too_large' });
    return;
  }
  if (parserType === 'entity.parse.failed') {
    res
      .status(400)
      .json({ error: 'validation_error', errors: ['body is not valid JSON'] });
    return;
  }

  logger.error(
    `[HTTP] ${req.method} ${req.originalUrl} unhandled:`,
    getErrorMessage(err),
  );
  const stack = getErrorStack(err);
  if (stack) logger.error(stack);
  res.status(500).json({ error: 'internal_error' });
}
