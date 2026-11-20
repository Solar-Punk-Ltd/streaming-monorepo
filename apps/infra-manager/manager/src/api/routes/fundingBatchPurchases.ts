import { type NextFunction, type Request, type RequestHandler, type Response, Router } from 'express';

import {
  UUID_PATTERN,
  fundingBatchPurchaseRequestSchema,
  fundingBatchPurchaseRestartRequestSchema,
  fundingStampPurchaseRequestSchema,
} from '@streaming-monorepo/contracts';

import { FundingApiError } from '../../domain/funding/FundingApiError.js';
import type { FundingBatchPurchaseService } from '../../domain/funding/FundingBatchPurchaseService.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

/** What a contract schema's `safeParse` answers, as these routes read it. */
type SafeParsed<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } };

/** A body parsed by the contract's schema, or 422 `stamp_refused` naming the field it does not take. */
function parsed<T>(schema: { safeParse(body: unknown): SafeParsed<T> }, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.join('.') || 'the body';
  throw new FundingApiError(
    'stamp_refused',
    `The request does not fit the contract: ${field} ${issue?.message ?? 'is not valid'}.`,
  );
}

/**
 * A route under a purchase's request id, which answers the purchase's status, uncached. A path parameter that is no
 * request id is the manager's own 404, as for any path no route names.
 */
function underPurchase(answer: (requestId: string, req: Request) => Promise<unknown>): RequestHandler {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const requestId = req.params.requestId as string;
    if (!UUID_PATTERN.test(requestId)) {
      next();
      return;
    }
    const status = await answer(requestId.toLowerCase(), req);
    res.setHeader('Cache-Control', 'no-store');
    res.json(status);
  });
}

/**
 * The funding API's batch purchase routes, mounted behind its gate beside the stamp routes:
 *
 * - `POST /batch-purchases` and `GET /batch-purchases/:requestId`, for a rung, for the catalogue or as an archive
 *   stamp;
 * - `POST /batch-purchases/:requestId/restart`, `/check` and `/release`, the three calls under a purchase, each
 *   answering its status;
 * - `POST /stamp-purchases` and `GET /stamp-purchases/:requestId`, the archive-only routes of an older admin, answered
 *   as a purchase of purpose `archive` in their own shape.
 *
 * A body is parsed by the contract's schema, and one it does not take is 422 `stamp_refused` naming the field, before
 * anything is read. A path parameter that is no request id is the manager's own 404, as for any path no route names.
 *
 * A `POST` of a purchase answers once the node has: Bee holds a purchase until its transaction is mined, up to the
 * three minutes of its on-chain budget, so a caller that gives up sooner reads the purchase's state on the `GET`.
 */
export function createFundingBatchPurchaseRouter(
  service: Pick<
    FundingBatchPurchaseService,
    'purchase' | 'status' | 'restart' | 'check' | 'release' | 'purchaseArchive' | 'archiveStatus'
  >,
): Router {
  const router = Router();

  router.post(
    '/batch-purchases',
    asyncHandler(async (req: Request, res: Response) => {
      const answer = await service.purchase(parsed(fundingBatchPurchaseRequestSchema, req.body));
      res.status(202).json(answer);
    }),
  );

  router.get(
    '/batch-purchases/:requestId',
    underPurchase((requestId) => service.status(requestId)),
  );

  router.post(
    '/batch-purchases/:requestId/restart',
    underPurchase((requestId, req) =>
      service.restart(requestId, parsed(fundingBatchPurchaseRestartRequestSchema, req.body).stageId),
    ),
  );

  router.post(
    '/batch-purchases/:requestId/check',
    underPurchase((requestId) => service.check(requestId)),
  );

  router.post(
    '/batch-purchases/:requestId/release',
    underPurchase((requestId) => service.release(requestId)),
  );

  router.post(
    '/stamp-purchases',
    asyncHandler(async (req: Request, res: Response) => {
      const answer = await service.purchaseArchive(parsed(fundingStampPurchaseRequestSchema, req.body));
      res.status(202).json(answer);
    }),
  );

  router.get(
    '/stamp-purchases/:requestId',
    underPurchase((requestId) => service.archiveStatus(requestId)),
  );

  return router;
}
