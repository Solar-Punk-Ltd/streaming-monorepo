import {
  AUTO_TOPUP_JOBS,
  type AutoTopUpJob,
  type AutoTopUpSettings,
  type AutoTopUpView,
} from '@streaming-monorepo/web2-admin-common';
import { clientIpOf } from '@streaming-monorepo/web-auth';
import { Request, RequestHandler, Response, Router } from 'express';
import { array, boolean, mixed, number, object, string } from 'yup';

import type { AuthService } from '../../domain/auth/AuthService.js';
import type { StampAutoTopUpService } from '../../domain/funding/StampAutoTopUpService.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { actorOf, signedInSession } from '../middleware/requireAuth.js';
import { validateBody, validateParams } from '../middleware/validate.js';

export interface AutoTopUpRoutesDeps {
  autoTopUp: Pick<StampAutoTopUpService, 'view' | 'saveSettings' | 'setMarks' | 'setJobPaused'>;
  /** The password check saving the settings asks for, a send's own. */
  authService: Pick<AuthService, 'confirmPassword'>;
  requireAuth: RequestHandler;
}

/** A whole number of base units, as the settings carry an amount; `autoTopUpSettingsProblems` says why one is not. */
const amount = () => string().defined();

const settingsSchema = object({
  password: string().required('password is required'),
  settings: object({
    topUpUnderDays: number().required(),
    topUpToDays: number().required(),
    lookAheadDays: number().required(),
    marginPercent: number().required(),
    xdaiWarningWei: amount().required(),
    dailyCeilingPlur: amount().nullable(),
  })
    .required()
    .noUnknown(true),
}).noUnknown(true);

const marksSchema = object({
  marked: boolean().required(),
  items: array()
    .of(
      object({
        nodeId: string().required(),
        batchId: string()
          .required()
          .matches(/^0x[0-9a-f]{64}$/, 'batchId is 0x and 64 hex digits in lower case'),
      }).noUnknown(true),
    )
    .required()
    .min(1, 'items names a stamp at least'),
}).noUnknown(true);

const jobParamsSchema = object({
  job: mixed<AutoTopUpJob>()
    .required()
    .oneOf([...AUTO_TOPUP_JOBS], `job is one of ${AUTO_TOPUP_JOBS.join(', ')}`),
});

const jobSchema = object({ paused: boolean().required() }).noUnknown(true);

/**
 * Stamp auto top-up's routes, under `/api/funding/auto-top-up` (`FUNDING_AUTO_TOPUP_PATH`), behind the session; the
 * writes behind the same-site check as well, which `src/api/server.ts` runs ahead of every console route. Each answers
 * the whole `AutoTopUpView`.
 *
 * - `GET /` answers the view.
 * - `PUT /settings` takes `AutoTopUpSettingsRequest`, behind the operator's password as a send is: 401
 *   `invalid_credentials` when it is wrong, 429 `too_many_attempts` once locked out, and 400 `validation_error` with
 *   `autoTopUpSettingsProblems`.
 * - `PUT /marks` takes `AutoTopUpMarksRequest`. A stamp the admin could not top up now, or that the manager does not
 *   list, answers 409 `not_markable` with a sentence for each in `problems`, and nothing is marked.
 * - `PUT /jobs/:job` takes `AutoTopUpJobRequest`.
 */
export function createAutoTopUpRouter(deps: AutoTopUpRoutesDeps): Router {
  const { autoTopUp, authService, requireAuth } = deps;
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      const response: AutoTopUpView = await autoTopUp.view();
      res.json(response);
    }),
  );

  router.put(
    '/settings',
    validateBody(settingsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { password: string; settings: AutoTopUpSettings };
      await authService.confirmPassword(
        signedInSession(req),
        body.password,
        'stamp auto top-up settings',
        clientIpOf(req),
      );
      const response: AutoTopUpView = await autoTopUp.saveSettings(actorOf(req), {
        ...body.settings,
        dailyCeilingPlur: body.settings.dailyCeilingPlur ?? null,
      });
      res.json(response);
    }),
  );

  router.put(
    '/marks',
    validateBody(marksSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { marked: boolean; items: { nodeId: string; batchId: string }[] };
      const response: AutoTopUpView = await autoTopUp.setMarks(actorOf(req), body.marked, body.items);
      res.json(response);
    }),
  );

  router.put(
    '/jobs/:job',
    validateParams(jobParamsSchema),
    validateBody(jobSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { paused } = req.body as { paused: boolean };
      const job = String(req.params.job) as AutoTopUpJob;
      const response: AutoTopUpView = await autoTopUp.setJobPaused(actorOf(req), job, paused);
      res.json(response);
    }),
  );

  return router;
}
