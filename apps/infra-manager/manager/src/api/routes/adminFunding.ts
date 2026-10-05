import express, { type NextFunction, type Request, type Response, Router } from 'express';

import type { FundingErrorAnswer, FundingInventory } from '@streaming-monorepo/contracts';

import { FundingApiError } from '../../domain/funding/FundingApiError.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createFundingGate } from '../middleware/fundingBearer.js';
import { notFound } from '../middleware/notFound.js';

/**
 * The funding API, mounted at `ADMIN_FUNDING_PATH` (`/api/admin-funding`) ahead of the manager's cross-site and
 * session gates, which are the operator's: the web2 admin calls it server to server with its bearer token, never
 * from a browser. `createFundingGate` guards every path under it, a body is parsed only once that gate has passed, and
 * each refusal is the contract's `{ error, message }` with the status of its code, a body the parser refuses
 * included.
 *
 * `routes` are the routers of the API's routes, mounted in order behind the gate: the inventory, then the chain's
 * routes (accounts, transfers). A route throws `FundingApiError` to refuse; anything else is the manager's own error
 * and goes on to its error handler.
 */
export function createAdminFundingRouter(token: string | null, routes: readonly Router[]): Router {
  const router = Router();
  router.use(createFundingGate(token));
  router.use(express.json({ limit: MAX_BODY }));
  for (const route of routes) router.use(route);
  // A path no route names is the manager's own 404, not one of the contract's codes, which name refusals.
  router.use(notFound);
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const unreadable = unreadableBody(err);
    if (unreadable) {
      const answer: FundingErrorAnswer = { error: 'bad_transaction', message: unreadable.message };
      res.status(unreadable.status).json(answer);
      return;
    }
    if (!(err instanceof FundingApiError)) {
      next(err);
      return;
    }
    const answer: FundingErrorAnswer = { error: err.code, message: err.message };
    res.status(err.status).json(answer);
  });
  return router;
}

/** The largest body the funding API reads, which a signed transfer fits many times over. */
const MAX_BODY = '256kb';

/**
 * A body the JSON parser refused, as the contract answers it: `bad_transaction`, with 413 for one over
 * {@link MAX_BODY} and 400 for one that is not JSON, so the web2 admin's client only ever meets the contract's
 * shape. Null for any other error.
 */
function unreadableBody(err: unknown): { status: number; message: string } | null {
  const type = (err as { type?: unknown } | null)?.type;
  if (type === 'entity.too.large') {
    return { status: 413, message: `The request body is over ${MAX_BODY}.` };
  }
  if (type === 'entity.parse.failed' || type === 'encoding.unsupported' || type === 'charset.unsupported') {
    return { status: 400, message: 'The request body is not JSON the funding API can read.' };
  }
  return null;
}

/** What the inventory route reads: every stage's nodes and the catalogue node, with their wallets. */
export interface FundingInventoryReader {
  inventory(): Promise<FundingInventory>;
}

/** `GET /inventory`, under the funding API: every stage's nodes and the catalogue node, read now, never cached. */
export function createFundingInventoryRouter(reader: FundingInventoryReader): Router {
  const router = Router();
  router.get(
    '/inventory',
    asyncHandler(async (_req: Request, res: Response) => {
      const answer = await reader.inventory();
      res.setHeader('Cache-Control', 'no-store');
      res.json(answer);
    }),
  );
  return router;
}
