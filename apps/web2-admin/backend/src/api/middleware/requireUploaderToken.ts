import { createHash } from 'node:crypto';

import { NextFunction, Request, RequestHandler, Response } from 'express';

import { UnauthenticatedError } from '../../domain/errors/index.js';
import { Logger } from '../../domain/Logger.js';
import { describeStage } from '../../domain/StageService.js';
import type { UploaderCaller } from '../../domain/uploaderScope.js';
import type { StageRow } from '../../types/index.js';

import { digest, presentedBearer, sameToken } from './requireInternalToken.js';

const logger = Logger.getInstance();

/** The slice of StageRepository the door needs; a fake stands in. */
export interface UploaderTokenStore {
  findActiveByOwnTokenSha256(sha256: string): Promise<StageRow[]>;
}

/** How often at most the admin says that an uploader is still on the shared token: once an hour. */
export const UNATTRIBUTED_LOG_PERIOD_MS = 60 * 60 * 1000;

/**
 * Counts the calls on the shared token and says when to log them: at the first call after boot, and then at the
 * first call at least a period after the last line, with how many calls there were since that line. Never a line
 * per request: an uploader calls on every segment it reports. The clock is injected so a test can move it.
 */
export class UnattributedCallLog {
  private lastLineAt: number | null = null;
  private sinceLastLine = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly periodMs: number = UNATTRIBUTED_LOG_PERIOD_MS,
  ) {}

  /** Counts one call, and answers the line to log for it, or null when it is not yet time for one. */
  note(): string | null {
    const at = this.now();
    this.sinceLastLine += 1;
    if (this.lastLineAt === null) {
      this.lastLineAt = at;
      this.sinceLastLine = 0;
      return '[Internal] unattributed uploader: a call on the shared INTERNAL_API_TOKEN, which names no stage. It is answered about every stream until that uploader has a token of its own: rotate it in the manager.';
    }
    if (at - this.lastLineAt < this.periodMs) return null;
    const count = this.sinceLastLine;
    const since = new Date(this.lastLineAt).toISOString();
    this.lastLineAt = at;
    this.sinceLastLine = 0;
    return `[Internal] unattributed uploader: ${count} call${count === 1 ? '' : 's'} on the shared INTERNAL_API_TOKEN since ${since}. Rotate each uploader's token in the manager.`;
  }
}

export interface RequireUploaderTokenOptions {
  /** `INTERNAL_API_TOKEN`: still taken from an uploader while the stages move over, as an unattributed caller. */
  sharedToken: string;
  stages: UploaderTokenStore;
  /** Where the lines about unattributed calls are counted; a test passes one with a clock of its own. */
  unattributed?: UnattributedCallLog;
}

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
  return stage ? { kind: 'stage', stageId: stage.stage_id, owner: stage.owner, name: stage.name } : null;
}

/**
 * The door to the uploader's routes under /api/internal. `Authorization: Bearer <token>`, read exactly as the
 * registrar's door reads it, and one of two tokens:
 *
 * - the shared `INTERNAL_API_TOKEN`, compared in constant time: an uploader not yet on a token of its own. It is let
 *   through unattributed (`req.uploaderCaller` is `{ kind: 'shared' }`) and answered as before stages had tokens,
 *   and the admin says so at info, at most once an hour;
 * - a stage's own token: its sha256 is looked up among the active stages whose record names a token of their `own`
 *   (`kind: 'own'`), and the one it matches is the caller. A retired stage's token, a hash a `shared` row carries
 *   (the shared token as it was when the manager pushed it, which is not taken once `INTERNAL_API_TOKEN` changes),
 *   and a hash no stage names are all 401. So is one that matches several stages, which cannot say which of them
 *   calls, with a warning in the log.
 *
 * Neither the token nor its hash is logged, at any level. A session cookie is not a token here either.
 */
export function createRequireUploaderToken(options: RequireUploaderTokenOptions): RequestHandler {
  const shared = digest(options.sharedToken);
  const { stages } = options;
  const unattributed = options.unattributed ?? new UnattributedCallLog();

  return (req: Request, _res: Response, next: NextFunction) => {
    const presented = presentedBearer(req);
    if (!presented) {
      next(new UnauthenticatedError());
      return;
    }

    if (sameToken(shared, presented)) {
      req.uploaderCaller = { kind: 'shared' };
      const line = unattributed.note();
      if (line) logger.info(line);
      next();
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
