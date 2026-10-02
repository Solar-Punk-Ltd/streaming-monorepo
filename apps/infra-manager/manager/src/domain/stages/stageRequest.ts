import { adminUrlProblem, type StagePushOutcome } from '@streaming-infra-manager/common';
import {
  ADMIN_ERROR_UNAUTHENTICATED,
  type StageRecord,
  stageRecordPath,
  type StageRetireRequest,
  stageRetireAnswerSchema,
  stageStoreAnswerSchema,
} from '@streaming-monorepo/contracts';

import { boundedJson } from '../adminLink/adminLinkProbe.js';
import { judgePlainHttpAdminLink, type PlainHttpJudge } from '../adminLink/plainHttpAdminLink.js';

/**
 * One call the stage publisher makes: store a record, or retire a stage as of the moment the manager saw its
 * deployment gone, which `DELETE` carries as `stageRetireRequestSchema` takes it.
 */
export type StageRequest =
  | { kind: 'store'; baseUrl: string; token: string; record: StageRecord }
  | { kind: 'retire'; baseUrl: string; token: string; stageId: string; observedAt: string };

export interface StageRequestOptions {
  /** How long the call may take in all. */
  timeoutMs?: number;
  /** The most of an answer that is read. The admin's own answers are a few bytes. */
  maxBodyBytes?: number;
  /** The rule for plain http to another host than the manager's own. The manager's own when left out. */
  plainHttp?: PlainHttpJudge;
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
 * or the moment the deployment was seen gone. On the Test connection probe's rules: http and https alone, plain http
 * only to the manager's own host, no redirect followed, five seconds in all, at most 64 KiB of the answer read, and
 * one outcome code. Nothing the far end sent reaches the answer, and neither does the address or the token.
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
  const body: StageRecord | StageRetireRequest =
    request.kind === 'store' ? request.record : { observedAt: request.observedAt };
  const answered = await boundedAdminCall(
    { baseUrl: request.baseUrl, path, method: request.kind === 'store' ? 'PUT' : 'DELETE', token: request.token, body },
    options,
  );
  if (typeof answered === 'string') return answered;
  return outcomeOf(request, answered.status, answered.body);
};

/** One call to the web2 admin's internal routes, as the stage and catalogue publishers make it. */
export interface AdminCall {
  baseUrl: string;
  path: string;
  method: 'PUT' | 'DELETE';
  token: string;
  body: unknown;
}

/**
 * Sends one JSON call with the link's token on the Test connection probe's rules: no redirect followed, five seconds
 * in all, at most 64 KiB of the answer read. Answers the status and the body read as JSON, or what stopped it. Never
 * throws, and what the far end sent goes to the caller alone. An address in plain http to another host than the
 * manager's own is sent nothing, since the call carries the registrar token, and answers `refused-plain-http`; one
 * in plain http to a name that does not resolve now is sent nothing either, and answers `unreachable`.
 */
export async function boundedAdminCall(
  call: AdminCall,
  options: StageRequestOptions = {},
): Promise<{ status: number; body: unknown } | 'unreachable' | 'redirected' | 'refused-plain-http'> {
  const plainHttp = await (options.plainHttp ?? judgePlainHttpAdminLink)(call.baseUrl);
  if (plainHttp === 'refused') return 'refused-plain-http';
  // A name that does not resolve now reaches nothing, and is judged again at the next call.
  if (plainHttp === 'unresolved') return 'unreachable';
  const url = `${call.baseUrl.replace(/\/+$/, '')}${call.path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: call.method,
      headers: { authorization: `Bearer ${call.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(call.body),
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
  try {
    return {
      status: response.status,
      body: await boundedJson(response, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES),
    };
  } catch {
    return 'unreachable';
  }
}
