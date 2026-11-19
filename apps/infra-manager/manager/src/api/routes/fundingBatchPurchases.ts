import { type NextFunction, type Request, type Response, Router } from 'express';

import { UUID_PATTERN, fundingStampPurchaseRequestSchema } from '@streaming-monorepo/contracts';

import { FundingApiError } from '../../domain/funding/FundingApiError.js';
import type { FundingStampPurchaseService } from '../../domain/funding/FundingBatchPurchaseService.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

/**
 * The funding API's stamp purchase routes, mounted behind its gate beside the stamp routes: `POST /stamp-purchases`
 * and `GET /stamp-purchases/:requestId`. A body is parsed by the contract's schema, and one it does not take is 422
 * `stamp_refused` naming the field, before anything is read. A path parameter that is no request id is the manager's
 * own 404, as for any path no route names.
 *
 * The `POST` answers once the node has: Bee holds a purchase until its transaction is mined, up to the three minutes
 * of its on-chain budget, so a caller that gives up sooner reads the purchase's state on the `GET`.
 */
export function createFundingStampPurchaseRouter(
  service: Pick<FundingStampPurchaseService, 'purchase' | 'status'>,
): Router {
  const router = Router();

  router.post(
    '/stamp-purchases',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = fundingStampPurchaseRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path.join('.') || 'the body';
        throw new FundingApiError(
          'stamp_refused',
          `The request does not fit the contract: ${field} ${issue?.message ?? 'is not valid'}.`,
        );
      }
      const answer = await service.purchase(parsed.data);
      res.status(202).json(answer);
    }),
  );

  router.get(
    '/stamp-purchases/:requestId',
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      const requestId = req.params.requestId as string;
      if (!UUID_PATTERN.test(requestId)) {
        next();
        return;
      }
      const answer = await service.status(requestId.toLowerCase());
      res.setHeader('Cache-Control', 'no-store');
      res.json(answer);
    }),
  );

  return router;
}
