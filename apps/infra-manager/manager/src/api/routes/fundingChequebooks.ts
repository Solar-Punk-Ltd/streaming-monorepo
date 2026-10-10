import { type NextFunction, type Request, type Response, Router } from 'express';

import { UUID_PATTERN, fundingChequebookOperationRequestSchema } from '@streaming-monorepo/contracts';

import { FundingApiError } from '../../domain/funding/FundingApiError.js';
import type { FundingChequebookService } from '../../domain/funding/FundingChequebookService.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

/**
 * The funding API's chequebook routes, mounted behind its gate beside the stamp routes: `POST /chequebook-operations`
 * and `GET /chequebook-operations/:requestId`. A body is parsed by the contract's schema, and one it does not take is
 * 422 `chequebook_refused` naming the field, before anything is read. A path parameter that is no request id is the
 * manager's own 404, as for any path no route names.
 *
 * The `POST` answers once the manager's chequebook path has: Bee answers a deposit or a withdrawal once it has sent
 * the transaction, and the path waits for that answer within its own budget, so a caller that gives up sooner reads
 * the operation's state on the `GET`.
 */
export function createFundingChequebookRouter(service: Pick<FundingChequebookService, 'operate' | 'status'>): Router {
  const router = Router();

  router.post(
    '/chequebook-operations',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = fundingChequebookOperationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path.join('.') || 'the body';
        throw new FundingApiError(
          'chequebook_refused',
          `The request does not fit the contract: ${field} ${issue?.message ?? 'is not valid'}.`,
        );
      }
      const answer = await service.operate(parsed.data);
      res.status(202).json(answer);
    }),
  );

  router.get(
    '/chequebook-operations/:requestId',
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
