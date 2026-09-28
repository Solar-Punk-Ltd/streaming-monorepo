import { adminUrlProblem, type StagePushOutcome } from '@streaming-infra-manager/common';
import {
  ADMIN_ERROR_UNAUTHENTICATED,
  type StageRecord,
  stageRecordPath,
  stageRetireAnswerSchema,
  stageStoreAnswerSchema,
} from '@streaming-monorepo/contracts';

import { boundedJson } from '../adminLink/adminLinkProbe.js';

/**
 * What `DELETE /api/internal/stages/:stageId` takes: the moment the manager saw the deployment gone, so a record read
 * before it and arriving after it cannot bring the stage back. The shape of `stageRetireRequestSchema` in the
 * contracts package.
 */
export interface StageRetireBody {
  observedAt: string;
}

/** One call the stage publisher makes: store a record, or retire a stage. */
export type StageRequest =
  | { kind: 'store'; baseUrl: string; token: string; record: StageRecord }
  | { kind: 'retire'; baseUrl: string; token: string; stageId: string; observedAt: string };

export interface StageRequestOptions {
  /** How long the call may take in all. */
  timeoutMs?: number;
  /** The most of an answer that is read. The admin's own answers are a few bytes. */
  maxBodyBytes?: number;
}

/** Sends one stage call and answers its outcome code. Never throws. */
export type StageSender = (request: StageRequest, options?: StageRequestOptions) => Promise<StagePushOutcome>;

/** The Test connection probe's bounds, which are the stream uploader's own lookup timeout. */
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

function errorCodeOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const code = (body as Record<string, unknown>).error;
  return typeof code === 'string' ? code : null;
}

/** What an answered call comes to, from its status and the body read as JSON. */
function outcomeOf(request: StageRequest, status: number, body: unknown): StagePushOutcome {
  if (status === 401) return errorCodeOf(body) === ADMIN_ERROR_UNAUTHENTICATED ? 'refused-token' : 'not-admin';
  if (status === 400 || status === 422) return 'refused-record';
  if (status < 200 || status >= 300) return 'not-admin';
  if (request.kind === 'store') {
    const answer = stageStoreAnswerSchema.safeParse(body);
    if (!answer.success) return 'not-admin';
    return answer.data.stored ? 'stored' : 'older-ignored';
  }
  const answer = stageRetireAnswerSchema.safeParse(body);
  if (!answer.success) return 'not-admin';
  return answer.data.retired ? 'retired' : 'not-retired';
}

/**
 * `PUT` or `DELETE <link>/api/internal/stages/<id>` with the link's token, and a JSON body either way: the record,
 * or the moment the deployment was seen gone. On
 * the Test connection probe's rules: http and https alone, no redirect
 * followed, five seconds in all, at most 64 KiB of the answer read, and one
 * outcome code. Nothing the far end sent reaches the answer, and neither does
 * the address or the token.
 */
export const sendStageRequest: StageSender = async (request, options = {}) => {
  if (adminUrlProblem(request.baseUrl) !== null) return 'not-admin';
  const stageId = request.kind === 'store' ? request.record.stageId : request.stageId;
  let path: string;
  try {
    path = stageRecordPath(stageId);
  } catch {
    return 'skipped-no-record';
  }
  const url = `${request.baseUrl.replace(/\/+$/, '')}${path}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${request.token}`,
    'content-type': 'application/json',
  };
  const body: StageRecord | StageRetireBody =
    request.kind === 'store' ? request.record : { observedAt: request.observedAt };

  let response: Response;
  try {
    response = await fetch(url, {
      method: request.kind === 'store' ? 'PUT' : 'DELETE',
      headers,
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    return 'unreachable';
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    return 'redirected';
  }
  let answer: unknown;
  try {
    answer = await boundedJson(response, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  } catch {
    return 'unreachable';
  }
  return outcomeOf(request, response.status, answer);
};
