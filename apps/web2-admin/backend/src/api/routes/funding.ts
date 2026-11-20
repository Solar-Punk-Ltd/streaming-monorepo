import { UUID_PATTERN } from '@streaming-monorepo/contracts';
import type {
  BatchPurchase,
  BatchPurchaseRequest,
  BatchPurchaseRestartRequest,
  BatchPurchasesResponse,
  FundingBulkAnswer,
  FundingChequebookBulkAnswer,
  FundingChequebookOperationsAnswer,
  FundingPinsAnswer,
  FundingStampBulkAnswer,
  FundingStampOperationsAnswer,
  FundingTransfersAnswer,
  FundingView,
} from '@streaming-monorepo/web2-admin-common';
import { clientIpOf } from '@streaming-monorepo/web-auth';
import { Request, RequestHandler, Response, Router } from 'express';
import { boolean, number, object, string } from 'yup';

import type { AuthService } from '../../domain/auth/AuthService.js';
import type { FundingService } from '../../domain/funding/FundingService.js';
import {
  chequebookOperationsOf,
  type FundingChequebookOperationsBody,
  type FundingPinsBody,
  type FundingStampOperationsBody,
  fundingBulkQuerySchema,
  fundingChequebookOperationsSchema,
  fundingPinsSchema,
  fundingStampOperationsSchema,
  type FundingTransfersBody,
  fundingTransfersSchema,
  stampOperationItemsOf,
} from '../../schemas/funding.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { actorOf, signedInSession } from '../middleware/requireAuth.js';
import { validateBody, validateParams } from '../middleware/validate.js';

export interface FundingRoutesDeps {
  fundingService: Pick<
    FundingService,
    | 'view'
    | 'pin'
    | 'send'
    | 'bulk'
    | 'stampOperations'
    | 'stampBulk'
    | 'chequebookOperations'
    | 'chequebookBulk'
    | 'batchPurchases'
    | 'startBatchPurchase'
    | 'batchPurchase'
    | 'restartBatchPurchase'
    | 'checkBatchPurchase'
  >;
  /** The password check a pin and a send ask for, the password change's own. */
  authService: Pick<AuthService, 'confirmPassword'>;
  requireAuth: RequestHandler;
}

/**
 * The Funding page's routes, under `/api/funding` (`FUNDING_PATH`), behind the session; the four writes behind the
 * same-site check as well, which `src/api/server.ts` runs ahead of every console route.
 *
 * - `GET /` answers `FundingView`.
 * - `POST /pins` takes `FundingPinsRequest` and answers `FundingPinsAnswer`.
 * - `POST /transfers` takes `FundingTransfersRequest` and answers `FundingTransfersAnswer` with 202.
 * - `GET /transfers?bulkId=` answers `FundingBulkAnswer`, refreshed from the manager.
 * - `POST /stamp-operations` takes `FundingStampOperationsRequest` and answers `FundingStampOperationsAnswer` with 202.
 * - `GET /stamp-operations?bulkId=` answers `FundingStampBulkAnswer`, refreshed from the manager.
 * - `POST /chequebook-operations` takes `FundingChequebookOperationsRequest` and answers
 *   `FundingChequebookOperationsAnswer` with 202.
 * - `GET /chequebook-operations?bulkId=` answers `FundingChequebookBulkAnswer`, refreshed from the manager.
 * - `GET /batch-purchases` answers `BatchPurchasesResponse`, read from the manager first.
 * - `POST /batch-purchases` takes `BatchPurchaseRequest` and answers the `BatchPurchase` with 202.
 * - `GET /batch-purchases/:id` answers the `BatchPurchase`; 404 `purchase_not_found` for an id never written.
 * - `POST /batch-purchases/:id/restart` takes `BatchPurchaseRestartRequest` and answers the `BatchPurchase`.
 * - `POST /batch-purchases/:id/check` takes no body and answers the `BatchPurchase`.
 *
 * A pin and a send ask for the operator's password first, checked as the password change checks the current one: 401
 * `invalid_credentials` when it is wrong, 429 `too_many_attempts` once locked out. A stamp request and a chequebook
 * request ask for none: the page's confirm dialog stands before them, since a node pays for its own stamp and
 * chequebook operations and nothing leaves the brand wallet. No answer carries a signed transaction: every item goes
 * out through `toFundingTransferItem`.
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
      await authService.confirmPassword(signedInSession(req), body.password, 'funding pin', clientIpOf(req));
      const response: FundingPinsAnswer = await fundingService.pin(actorOf(req), body.nodeIds);
      res.json(response);
    }),
  );

  router.post(
    '/transfers',
    validateBody(fundingTransfersSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as FundingTransfersBody;
      await authService.confirmPassword(signedInSession(req), body.password, 'funding send', clientIpOf(req));
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

  router.post(
    '/chequebook-operations',
    validateBody(fundingChequebookOperationsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as FundingChequebookOperationsBody;
      const response: FundingChequebookOperationsAnswer = await fundingService.chequebookOperations(
        actorOf(req),
        chequebookOperationsOf(body),
      );
      res.status(202).json(response);
    }),
  );

  router.get(
    '/chequebook-operations',
    asyncHandler(async (req: Request, res: Response) => {
      const query = await fundingBulkQuerySchema.validate(
        { bulkId: req.query.bulkId },
        { abortEarly: false, stripUnknown: true },
      );
      const response: FundingChequebookBulkAnswer = await fundingService.chequebookBulk(query.bulkId.toLowerCase());
      res.json(response);
    }),
  );

  router.get(
    '/batch-purchases',
    asyncHandler(async (_req: Request, res: Response) => {
      const response: BatchPurchasesResponse = await fundingService.batchPurchases();
      res.json(response);
    }),
  );

  router.post(
    '/batch-purchases',
    validateBody(batchPurchaseSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const response: BatchPurchase = await fundingService.startBatchPurchase(
        actorOf(req),
        req.body as BatchPurchaseRequest,
      );
      res.status(202).json(response);
    }),
  );

  router.get(
    '/batch-purchases/:id',
    validateParams(purchaseIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const id = purchaseIdOf(req);
      answerPurchase(res, id, await fundingService.batchPurchase(id));
    }),
  );

  router.post(
    '/batch-purchases/:id/restart',
    validateParams(purchaseIdParamSchema),
    validateBody(purchaseRestartSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { stageId } = req.body as BatchPurchaseRestartRequest;
      const id = purchaseIdOf(req);
      answerPurchase(res, id, await fundingService.restartBatchPurchase(actorOf(req), id, stageId.toLowerCase()));
    }),
  );

  router.post(
    '/batch-purchases/:id/check',
    validateParams(purchaseIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const id = purchaseIdOf(req);
      answerPurchase(res, id, await fundingService.checkBatchPurchase(actorOf(req), id));
    }),
  );

  return router;
}

/** A purchase's id from the path, which {@link purchaseIdParamSchema} held to a UUID, in lower case. */
function purchaseIdOf(req: Request): string {
  return String(req.params.id).toLowerCase();
}

/** The purchase, or 404 `purchase_not_found` for an id the admin never wrote. */
function answerPurchase(res: Response, id: string, purchase: BatchPurchase | null): void {
  if (purchase === null) {
    res.status(404).json({ error: 'purchase_not_found', id });
    return;
  }
  res.json(purchase);
}

/** The id of a purchase in its path. */
const purchaseIdParamSchema = object({
  id: string().required().matches(UUID_PATTERN, 'id must be a UUID'),
}).strict();

/**
 * `POST /api/funding/batch-purchases`: a `BatchPurchaseRequest`. The shape is held here; what the purpose takes, the
 * cost at today's price and the wallet are the purchase service's to check.
 */
const batchPurchaseSchema = object({
  purpose: string()
    .strict()
    .required('purpose is required')
    .oneOf(['rung', 'catalogue'] as const, 'purpose must be rung or catalogue'),
  nodeId: string()
    .strict()
    .required('nodeId is required')
    .matches(/^[A-Za-z0-9:._-]{1,200}$/, 'nodeId must be 1 to 200 letters, digits or :._-'),
  depth: number()
    .strict()
    .required('depth is required')
    .integer('depth must be a whole number')
    .min(0, 'depth must be 0 or more')
    .max(255, 'depth must be at most 255'),
  immutable: boolean().strict().required('immutable is required'),
  days: number()
    .strict()
    .required('days is required')
    .integer('days must be a whole number')
    .min(1, 'days must be 1 or more')
    .max(2 ** 31 - 1, `days must be at most ${2 ** 31 - 1}`),
  costPlur: string()
    .strict()
    .required('costPlur is required')
    .matches(/^[1-9][0-9]{0,77}$/, 'costPlur must be a whole number of PLUR above 0'),
  replacesBatchId: string()
    .strict()
    .nullable()
    .defined('replacesBatchId is required, null for a node with no batch')
    .matches(/^0x[0-9a-fA-F]{64}$/, 'replacesBatchId must be 0x and 64 hex digits'),
});

/** `POST /api/funding/batch-purchases/:id/restart`: a `BatchPurchaseRestartRequest`. */
const purchaseRestartSchema = object({
  stageId: string().strict().required('stageId is required').matches(UUID_PATTERN, 'stageId must be a UUID'),
});
