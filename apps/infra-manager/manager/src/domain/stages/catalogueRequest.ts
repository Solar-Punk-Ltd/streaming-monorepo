import { adminUrlProblem, type CataloguePushOutcome } from '@streaming-infra-manager/common';
import {
  ADMIN_ERROR_UNAUTHENTICATED,
  CATALOGUE_STAMP_PATH,
  type CatalogueStampRecord,
  catalogueStampClearAnswerSchema,
  catalogueStampClearRequestSchema,
  catalogueStampRecordSchema,
  stageStoreAnswerSchema,
} from '@streaming-monorepo/contracts';

import { boundedAdminCall, type StageRequestOptions } from './stageRequest.js';

/**
 * One call the catalogue publisher makes: store the catalogue stamp record, or clear it as of the moment the
 * designation was taken out, which `DELETE` carries as `catalogueStampClearRequestSchema` takes it.
 */
export type CatalogueRequest =
  | { kind: 'store'; baseUrl: string; token: string; record: CatalogueStampRecord }
  | { kind: 'clear'; baseUrl: string; token: string; observedAt: string };

/** Sends one catalogue call and answers its outcome code. Never throws. */
export type CatalogueSender = (
  request: CatalogueRequest,
  options?: StageRequestOptions,
) => Promise<CataloguePushOutcome>;

function errorCodeOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const code = (body as Record<string, unknown>).error;
  return typeof code === 'string' ? code : null;
}

function outcomeOf(request: CatalogueRequest, status: number, body: unknown): CataloguePushOutcome {
  if (status === 401) return errorCodeOf(body) === ADMIN_ERROR_UNAUTHENTICATED ? 'refused-token' : 'not-admin';
  if (status === 400 || status === 422) return 'refused-record';
  if (status < 200 || status >= 300) return 'not-admin';
  if (request.kind === 'store') {
    const answer = stageStoreAnswerSchema.safeParse(body);
    if (!answer.success) return 'not-admin';
    return answer.data.stored ? 'stored' : 'older-ignored';
  }
  const answer = catalogueStampClearAnswerSchema.safeParse(body);
  if (!answer.success) return 'not-admin';
  return answer.data.cleared ? 'cleared' : 'not-cleared';
}

/**
 * `PUT` or `DELETE <link>/api/internal/catalogue-stamp` with the link's token, on the stage client's rules: http and
 * https alone, no redirect followed, five seconds in all, at most 64 KiB of the answer read, and one outcome code.
 * The body is checked against the contract's schema before it leaves, and one that fails is not sent.
 */
export const sendCatalogueRequest: CatalogueSender = async (request, options = {}) => {
  if (adminUrlProblem(request.baseUrl) !== null) return 'not-admin';
  const body =
    request.kind === 'store'
      ? catalogueStampRecordSchema.safeParse(request.record)
      : catalogueStampClearRequestSchema.safeParse({ observedAt: request.observedAt });
  if (!body.success) return 'skipped-no-record';
  const answered = await boundedAdminCall(
    {
      baseUrl: request.baseUrl,
      path: CATALOGUE_STAMP_PATH,
      method: request.kind === 'store' ? 'PUT' : 'DELETE',
      token: request.token,
      body: body.data,
    },
    options,
  );
  if (answered === 'unreachable' || answered === 'redirected') return answered;
  return outcomeOf(request, answered.status, answered.body);
};
