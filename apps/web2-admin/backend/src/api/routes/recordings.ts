import {
  LOST_RECORDINGS_REMOVAL_PATH,
  RECORDING_CHECK_PATH,
  type LostRecordingsRemovalRequest,
} from '@streaming-monorepo/web2-admin-common';
import { Request, RequestHandler, Response, Router } from 'express';
import { array, object, string } from 'yup';

import { RecordingsRefusedError, type RecordingCheckService } from '../../domain/recordings/RecordingCheckService.js';
import { UUID_RE } from '../../schemas/stream.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { actorOf } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validate.js';

/** Where the router is mounted: the common prefix of the check's and the removal's routes. */
export const RECORDINGS_PATH = '/api/recordings';

/** The most recordings one removal names; far above what one check finds. */
const REMOVAL_MAX_STREAMS = 10_000;

export const lostRecordingsRemovalSchema = object({
  checkId: string().required().matches(UUID_RE, 'checkId must be a UUID'),
  streamIds: array(string().required().matches(UUID_RE, 'each stream id must be a UUID'))
    .required()
    .max(REMOVAL_MAX_STREAMS, `at most ${REMOVAL_MAX_STREAMS} recordings at a time`),
}).strict();

export interface RecordingsRoutesDeps {
  recordings: RecordingCheckService;
  requireAuth: RequestHandler;
}

/** Answers what `work` gives, or `409` with the sentence when the check or the removal refuses. */
function answering<T>(work: (req: Request) => Promise<T>): RequestHandler {
  return asyncHandler(async (req: Request, res: Response) => {
    try {
      const answer = await work(req);
      res.set('Cache-Control', 'no-store');
      res.json(answer);
    } catch (error) {
      if (!(error instanceof RecordingsRefusedError)) throw error;
      res.status(409).json({ error: 'recordings_refused', message: error.message });
    }
  });
}

/**
 * Checking the recordings and removing the lost ones, for every signed-in user. `docs/architecture/web2-admin.md`,
 * "Lost recordings".
 *
 * - `GET /api/recordings/check` answers the latest check, and why a new one cannot start, or its lost recordings
 *   cannot be removed, now: `RecordingCheckResponse`.
 * - `POST /api/recordings/check` starts a check and answers the same, or `409` with the sentence: one is running, or
 *   the catalogue node cannot be read through.
 * - `POST /api/recordings/lost/removal` takes `LostRecordingsRemovalRequest`, the check and the list its confirm
 *   showed, and answers `LostRecordingsRemovalResponse`, or `409` with the sentence: the check is not the latest, not
 *   done, too old, lists another set of recordings, or the catalogue cannot be written.
 */
export function createRecordingsRouter(deps: RecordingsRoutesDeps): Router {
  const { recordings, requireAuth } = deps;
  const router = Router();
  const check = RECORDING_CHECK_PATH.slice(RECORDINGS_PATH.length);
  const removal = LOST_RECORDINGS_REMOVAL_PATH.slice(RECORDINGS_PATH.length);

  router.use(requireAuth);

  router.get(
    check,
    answering(() => recordings.status()),
  );

  router.post(
    check,
    answering((req) => recordings.start(actorOf(req))),
  );

  router.post(
    removal,
    validateBody(lostRecordingsRemovalSchema),
    answering((req) => recordings.removeLost(actorOf(req), req.body as LostRecordingsRemovalRequest)),
  );

  return router;
}
