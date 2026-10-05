import { type NextFunction, type Request, type Response, Router } from 'express';

import { UUID_PATTERN, fundingTransferRequestSchema } from '@streaming-monorepo/contracts';

import { FundingApiError } from '../../domain/funding/FundingApiError.js';
import type { FundingChainService } from '../../domain/funding/FundingChainService.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The funding API's chain routes, mounted behind its gate beside the inventory: `GET /accounts/:address`,
 * `POST /transfers` and `GET /transfers/:requestId`. A transfer body is parsed by the contract's schema, and one it
 * does not take is 422 `bad_transaction` naming the field. A path parameter that is no address or request id is the
 * manager's own 404, as for any path no route names.
 */
export function createFundingChainRouter(
  service: Pick<FundingChainService, 'account' | 'transfer' | 'status'>,
): Router {
  const router = Router();

  router.get(
    '/accounts/:address',
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      const address = req.params.address as string;
      if (!ADDRESS.test(address)) {
        next();
        return;
      }
      const answer = await service.account(address.toLowerCase());
      res.setHeader('Cache-Control', 'no-store');
      res.json(answer);
    }),
  );

  router.post(
    '/transfers',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = fundingTransferRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path.join('.') || 'the body';
        throw new FundingApiError(
          'bad_transaction',
          `The request does not fit the contract: ${field} ${issue?.message ?? 'is not valid'}.`,
        );
      }
      const answer = await service.transfer(parsed.data);
      res.status(202).json(answer);
    }),
  );

  router.get(
    '/transfers/:requestId',
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
