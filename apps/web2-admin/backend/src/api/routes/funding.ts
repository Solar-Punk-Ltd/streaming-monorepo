import type {
  FundingBulkAnswer,
  FundingPinsAnswer,
  FundingStampBulkAnswer,
  FundingStampOperationsAnswer,
  FundingTransfersAnswer,
  FundingView,
} from '@streaming-monorepo/web2-admin-common';
import { Request, RequestHandler, Response, Router } from 'express';

import type { AuthService } from '../../domain/auth/AuthService.js';
import type { FundingService } from '../../domain/funding/FundingService.js';
import {
  type FundingPinsBody,
  type FundingStampOperationsBody,
  fundingBulkQuerySchema,
  fundingPinsSchema,
  fundingStampOperationsSchema,
  type FundingTransfersBody,
  fundingTransfersSchema,
  stampOperationItemsOf,
} from '../../schemas/funding.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { actorOf, signedInSession } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validate.js';

export interface FundingRoutesDeps {
  fundingService: Pick<FundingService, 'view' | 'pin' | 'send' | 'bulk' | 'stampOperations' | 'stampBulk'>;
  /** The password check a pin and a send ask for, the password change's own. */
  authService: Pick<AuthService, 'confirmPassword'>;
  requireAuth: RequestHandler;
}

/**
 * The Funding page's routes, under `/api/funding` (`FUNDING_PATH`), behind the session; the three writes behind the
 * same-site check as well, which `src/api/server.ts` runs ahead of every console route.
 *
 * - `GET /` answers `FundingView`.
 * - `POST /pins` takes `FundingPinsRequest` and answers `FundingPinsAnswer`.
 * - `POST /transfers` takes `FundingTransfersRequest` and answers `FundingTransfersAnswer` with 202.
 * - `GET /transfers?bulkId=` answers `FundingBulkAnswer`, refreshed from the manager.
 * - `POST /stamp-operations` takes `FundingStampOperationsRequest` and answers `FundingStampOperationsAnswer` with 202.
 * - `GET /stamp-operations?bulkId=` answers `FundingStampBulkAnswer`, refreshed from the manager.
 *
 * A pin and a send ask for the operator's password first, checked as the password change checks the current one: 401
 * `invalid_credentials` when it is wrong, 429 `too_many_attempts` once locked out. A stamp request asks for none: the
 * page's confirm dialog stands before it, since a node pays for its own stamp operations and nothing leaves the brand
 * wallet. No answer carries a signed transaction: every item goes out through `toFundingTransferItem`.
 */
export function createFundingRouter(deps: FundingRoutesDeps): Router {
  const { fundingService, authService, requireAuth } = deps;
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      const response: FundingView = await fundingService.view();
      res.json(response);
    }),
  );

  router.post(
    '/pins',
    validateBody(fundingPinsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as FundingPinsBody;
      await authService.confirmPassword(signedInSession(req), body.password, 'funding pin');
      const response: FundingPinsAnswer = await fundingService.pin(actorOf(req), body.nodeIds);
      res.json(response);
    }),
  );

  router.post(
    '/transfers',
    validateBody(fundingTransfersSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as FundingTransfersBody;
      await authService.confirmPassword(signedInSession(req), body.password, 'funding send');
      const response: FundingTransfersAnswer = await fundingService.send(actorOf(req), body.items);
      res.status(202).json(response);
    }),
  );

  router.get(
    '/transfers',
    asyncHandler(async (req: Request, res: Response) => {
      const query = await fundingBulkQuerySchema.validate(
        { bulkId: req.query.bulkId },
        { abortEarly: false, stripUnknown: true },
      );
      const response: FundingBulkAnswer = await fundingService.bulk(query.bulkId.toLowerCase());
      res.json(response);
    }),
  );

  router.post(
    '/stamp-operations',
    validateBody(fundingStampOperationsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as FundingStampOperationsBody;
      const response: FundingStampOperationsAnswer = await fundingService.stampOperations(
        actorOf(req),
        stampOperationItemsOf(body),
      );
      res.status(202).json(response);
    }),
  );

  router.get(
    '/stamp-operations',
    asyncHandler(async (req: Request, res: Response) => {
      const query = await fundingBulkQuerySchema.validate(
        { bulkId: req.query.bulkId },
        { abortEarly: false, stripUnknown: true },
      );
      const response: FundingStampBulkAnswer = await fundingService.stampBulk(query.bulkId.toLowerCase());
      res.json(response);
    }),
  );

  return router;
}
