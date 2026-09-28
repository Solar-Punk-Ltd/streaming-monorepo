import { createHash } from 'node:crypto';

import { NextFunction, Request, RequestHandler, Response } from 'express';

import { UnauthenticatedError } from '../../domain/errors/index.js';
import { Logger } from '../../domain/Logger.js';
import { describeStage } from '../../domain/StageService.js';
import type { UploaderCaller } from '../../domain/uploaderScope.js';
import type { StageRow } from '../../types/index.js';

import { presentedBearer } from './requireInternalToken.js';

const logger = Logger.getInstance();

/** The slice of StageRepository the door needs; a fake stands in. */
export interface UploaderTokenStore {
  findActiveByOwnTokenSha256(sha256: string): Promise<StageRow[]>;
}

export interface RequireUploaderTokenOptions {
  stages: UploaderTokenStore;
}

/**
 * The shape of a stage's own token: the manager generates 64 hex characters. Anything else is refused before the
 * database is asked, so a caller cannot make the admin query for every guess it sends.
 */
const OWN_TOKEN_SHAPE = /^[0-9a-f]{64}$/i;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The stage whose own token this is, or null when there is none or more than one. */
async function attribute(stages: UploaderTokenStore, presented: string): Promise<UploaderCaller | null> {
  const matches = await stages.findActiveByOwnTokenSha256(sha256Hex(presented));
  if (matches.length > 1) {
    logger.warn(
      `[Internal] refused an uploader call: its token is the own token of several active stages (${matches
        .map((stage) => describeStage({ name: stage.name, stageId: stage.stage_id }))
        .join(', ')}), so it cannot say which stage calls. The manager must give each stage a token of its own.`,
    );
    return null;
  }
  const [stage] = matches;
  return stage ? { stageId: stage.stage_id, owner: stage.owner, name: stage.name } : null;
}

/**
 * The door to the uploader's routes under /api/internal. `Authorization: Bearer <token>`, read exactly as the
 * registrar's door reads it, and one kind of token alone: a stage's own, 64 hex characters as the manager generates
 * it (anything else is 401 without a query). Its sha256 is looked up among the active stages whose record names a
 * token of their `own`, and the one it matches is the caller, answered only about that stage's streams.
 *
 * Everything else is 401 `unauthenticated`: the registrar token, `INTERNAL_API_TOKEN`, which is the manager's alone
 * since phase 9 of docs/architecture/stages.md; a retired stage's token; the hash a `shared` record carries, a token
 * the manager did not generate, which that stage has to rotate in the manager; a hash no stage names; and one that
 * matches several stages, which cannot say which of them calls, with a warning in the log.
 *
 * Neither the token nor its hash is logged, at any level. A session cookie is not a token here either.
 */
export function createRequireUploaderToken(options: RequireUploaderTokenOptions): RequestHandler {
  const { stages } = options;

  return (req: Request, _res: Response, next: NextFunction) => {
    const presented = presentedBearer(req);
    if (!presented || !OWN_TOKEN_SHAPE.test(presented)) {
      next(new UnauthenticatedError());
      return;
    }

    // Called once, whichever way the lookup goes: a failed lookup is the error handler's, as in any route.
    attribute(stages, presented).then((caller) => {
      if (!caller) {
        next(new UnauthenticatedError());
        return;
      }
      req.uploaderCaller = caller;
      next();
    }, next);
  };
}

/** The caller `requireUploaderToken` let through. Refuses a request that did not come through it. */
export function uploaderCallerOf(req: Request): UploaderCaller {
  if (!req.uploaderCaller) throw new UnauthenticatedError();
  return req.uploaderCaller;
}
