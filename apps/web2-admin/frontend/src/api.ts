import type {
  AddUserRequest,
  CatalogueMoveRequest,
  CatalogueMoveStatus,
  CatalogueStampResponse,
  CatalogueStampSummary,
  CatalogueWriteStatus,
  ChangePasswordRequest,
  IngestDetails,
  MeResponse,
  PublicConfig,
  PublishResult,
  StageListResponse,
  StageSummary,
  Stream,
  StreamInput,
  StreamListResponse,
  User,
  UserListResponse,
  UserSummary,
  VersionInfo,
} from '@streaming-monorepo/web2-admin-common';
import { VERSION_PATH } from '@streaming-monorepo/web2-admin-common';

import {
  FUNDING_CHEQUEBOOK_OPERATIONS_ADMIN_PATH,
  FUNDING_PATH,
  FUNDING_PINS_PATH,
  FUNDING_STAMP_OPERATIONS_ADMIN_PATH,
  FUNDING_TRANSFERS_ADMIN_PATH,
  fundingBulkPath,
  fundingChequebookBulkPath,
  fundingStampBulkPath,
  type FundingBulkAnswer,
  type FundingChequebookBulkAnswer,
  type FundingChequebookItem,
  type FundingChequebookOperationsAnswer,
  type FundingChequebookOperationsRequest,
  type FundingPinsAnswer,
  type FundingPinsRequest,
  type FundingStampBulkAnswer,
  type FundingStampItem,
  type FundingStampOperationsAnswer,
  type FundingStampOperationsRequest,
  type FundingTransferItem,
  type FundingTransferItemRequest,
  type FundingTransfersAnswer,
  type FundingTransfersRequest,
  type FundingView,
  type StampOperationItemRequest,
} from '@streaming-monorepo/web2-admin-common';

import { SIGN_IN_MESSAGES, tooManyAttempts } from './authMessages';
import {
  apiFetch,
  extractApiError,
  failWith,
  getJson,
  send,
  sendBytes,
  sendDelete,
  sendEmpty,
  sendJson,
  sessionEnded,
  ApiError,
} from './http';

const API = '/api';

// --- auth -------------------------------------------------------------------

/** Why nobody is signed in, which is the whole of what the login page says. */
export type SignedOutReason = 'notSignedIn' | 'noUsers' | 'ended' | 'unreachable';

export type SessionProbe = { signedIn: true; user: User } | { signedIn: false; reason: SignedOutReason };

export type SignInResult = { ok: true; user: User } | { ok: false; message: string };

/** What to say when a 429 carries neither a body nor a Retry-After header. */
const LOCKOUT_FALLBACK_SECONDS = 60;

/**
 * How long the lockout has left. The body is the authority — it is the number
 * the API actually counted — and the `Retry-After` header is the fallback for
 * a 429 that came from nginx's own rate limit zone rather than from the API,
 * which answers no body at all.
 */
async function retryAfterOf(res: Response): Promise<number> {
  const header = Number(res.headers?.get('retry-after'));
  try {
    const body = (await res.json()) as { retryAfterSeconds?: number };
    if (body.retryAfterSeconds) return body.retryAfterSeconds;
  } catch {
    /* the header below is the fallback */
  }
  return Number.isFinite(header) && header > 0 ? header : LOCKOUT_FALLBACK_SECONDS;
}

/**
 * Who is signed in, asked once on boot.
 *
 * 401 is an answer here rather than a session ending, and its body separates
 * "nobody is signed in" from "no user has been created yet", which are two
 * very different things to tell whoever is looking at the screen.
 */
export async function probeSession(): Promise<SessionProbe> {
  try {
    const res = await apiFetch(`${API}/auth/session`, {}, { allowUnauthorized: true });

    if (res.ok) {
      return { signedIn: true, user: ((await res.json()) as MeResponse).user };
    }
    if (res.status === 401) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return {
        signedIn: false,
        reason: body.error === 'no_users' ? 'noUsers' : 'notSignedIn',
      };
    }
    return { signedIn: false, reason: 'unreachable' };
  } catch {
    return { signedIn: false, reason: 'unreachable' };
  }
}

/**
 * Logging in. Answers rather than throws, because every way it can fail is
 * something the form has to print above the password field.
 */
export async function signIn(username: string, password: string): Promise<SignInResult> {
  let res: Response;
  try {
    res = await apiFetch(
      `${API}/auth/login`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      },
      { allowUnauthorized: true },
    );
  } catch {
    return { ok: false, message: SIGN_IN_MESSAGES.unreachable };
  }

  if (res.ok) {
    try {
      return { ok: true, user: ((await res.json()) as MeResponse).user };
    } catch {
      return { ok: false, message: SIGN_IN_MESSAGES.unreachable };
    }
  }
  if (res.status === 429) {
    return { ok: false, message: tooManyAttempts(await retryAfterOf(res)) };
  }
  if (res.status === 401) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      ok: false,
      message: body.error === 'no_users' ? SIGN_IN_MESSAGES.noUsers : SIGN_IN_MESSAGES.wrongPair,
    };
  }
  return {
    ok: false,
    message: await extractApiError(res, SIGN_IN_MESSAGES.unreachable),
  };
}

/**
 * Whether the session is still alive, asked again when the operator comes back
 * to the tab. Behind the gate on purpose: a 401 here is a session that ended,
 * so it goes through the fetch wrapper's sign-out like any other.
 */
export async function checkSession(): Promise<User> {
  const body = await getJson<MeResponse>(`${API}/auth/me`);
  return body.user;
}

export function logout(): Promise<void> {
  return sendEmpty(`${API}/auth/logout`);
}

/**
 * A 401 here usually means the current password was wrong, not that the
 * session has gone, so it is answered rather than turned into a sign-out. The
 * exception is a 401 whose body says `unauthenticated`: the session itself
 * ended, and the console signs out as it would for any other request.
 *
 * Answers the updated user when the API returns one, so the console can show
 * the new `passwordChangedAt` without another round trip.
 */
export async function changePassword(body: ChangePasswordRequest): Promise<User | null> {
  const res = await apiFetch(
    `${API}/auth/password`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    { allowUnauthorized: true },
  );

  if (res.status === 401) {
    const answer = (await res.json().catch(() => ({}))) as { error?: string };
    if (answer.error === 'unauthenticated') sessionEnded();
    throw new ApiError('That is not your current password.', 'invalid_credentials', 401);
  }
  if (!res.ok) await failWith(res, 'Could not change the password.');

  const answer = (await res.json().catch(() => null)) as MeResponse | null;
  return answer?.user ?? null;
}

export async function fetchUsers(): Promise<UserSummary[]> {
  const body = await getJson<UserListResponse>(`${API}/auth/users`);
  return body.users;
}

export function addUser(body: AddUserRequest): Promise<void> {
  return send('POST', `${API}/auth/users`, body);
}

export function removeUser(id: string): Promise<void> {
  return send('DELETE', `${API}/auth/users/${encodeURIComponent(id)}`);
}

export function revokeSessions(id: string): Promise<void> {
  return send('POST', `${API}/auth/users/${encodeURIComponent(id)}/revoke`, {});
}

// --- streams ----------------------------------------------------------------

export async function fetchStreams(): Promise<Stream[]> {
  const body = await getJson<StreamListResponse>(`${API}/streams`);
  return body.streams;
}

export function fetchStream(id: string): Promise<Stream> {
  return getJson<Stream>(`${API}/streams/${encodeURIComponent(id)}`);
}

export function createStream(input: StreamInput): Promise<Stream> {
  return sendJson<Stream>('POST', `${API}/streams`, input);
}

export function updateStream(id: string, input: StreamInput): Promise<Stream> {
  return sendJson<Stream>('PUT', `${API}/streams/${encodeURIComponent(id)}`, input);
}

export async function deleteStream(id: string): Promise<void> {
  await sendDelete(`${API}/streams/${encodeURIComponent(id)}`);
}

// --- thumbnail --------------------------------------------------------------

export function uploadThumbnail(id: string, file: File): Promise<Stream> {
  return sendBytes<Stream>(
    `${API}/streams/${encodeURIComponent(id)}/thumbnail`,
    file,
    file.type || 'application/octet-stream',
    { fallback: 'The thumbnail is larger than the 5MB limit.' },
  );
}

export async function deleteThumbnail(id: string): Promise<Stream | null> {
  return sendDelete<Stream>(`${API}/streams/${encodeURIComponent(id)}/thumbnail`);
}

/**
 * `updatedAt` busts the browser cache: the URL is stable per stream, so
 * without it a replaced image keeps showing the old bytes.
 */
export function thumbnailUrl(stream: Stream): string {
  return `${API}/streams/${encodeURIComponent(stream.id)}/thumbnail?v=${encodeURIComponent(stream.updatedAt)}`;
}

// --- publish ----------------------------------------------------------------

export function publishStream(id: string): Promise<PublishResult> {
  return sendJson<PublishResult>('POST', `${API}/streams/${encodeURIComponent(id)}/publish`);
}

export function unpublishStream(id: string): Promise<PublishResult> {
  return sendJson<PublishResult>('POST', `${API}/streams/${encodeURIComponent(id)}/unpublish`);
}

// --- ingest -----------------------------------------------------------------

export function fetchIngest(id: string): Promise<IngestDetails> {
  return getJson<IngestDetails>(`${API}/streams/${encodeURIComponent(id)}/ingest`);
}

export function rotateIngestKey(id: string): Promise<IngestDetails> {
  return sendJson<IngestDetails>('POST', `${API}/streams/${encodeURIComponent(id)}/ingest/rotate-key`);
}

// --- stages -----------------------------------------------------------------

export async function fetchStages(): Promise<StageSummary[]> {
  const body = await getJson<StageListResponse>(`${API}/stages`);
  return body.stages;
}

/**
 * The catalogue batch and the move of its history, as the Stages page shows them. An answer without the move (an
 * admin older than it) reads as no move to show.
 */
export async function fetchCatalogueState(): Promise<{
  stamp: CatalogueStampSummary | null;
  move: CatalogueMoveStatus | null;
}> {
  const body = await getJson<Partial<CatalogueStampResponse>>(`${API}/catalogue-stamp`);
  return { stamp: body.catalogueStamp ?? null, move: body.catalogueMove ?? null };
}

/** Starts the move of the catalogue's history to the batch the page named, or retries a failed one. */
export function startCatalogueMove(targetBatchId: string): Promise<CatalogueMoveStatus> {
  const body: CatalogueMoveRequest = { targetBatchId };
  return sendJson<CatalogueMoveStatus>('POST', `${API}/catalogue-stamp/move`, body);
}

/** What the next catalogue write does: the batch it goes through, why it is refused, and a move that is waiting. */
export async function fetchCatalogueWrite(): Promise<CatalogueWriteStatus> {
  const body = await getJson<CatalogueStampResponse>(`${API}/catalogue-stamp`);
  return body.catalogueWrite;
}

// --- funding ----------------------------------------------------------------

/** The brand wallet and every stage's nodes with their balances and address checks, as the Funding page shows them. */
export function fetchFunding(): Promise<FundingView> {
  return getJson<FundingView>(FUNDING_PATH);
}

/**
 * A funding write that carries the operator's own password. As with the password change, a 401 here is a wrong
 * password and not a session that ended, unless the API says the session ended, and a 429 is the login limiter's
 * lockout.
 */
async function sendWithPassword<T>(path: string, body: unknown, fallback: string): Promise<T> {
  const res = await apiFetch(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    { allowUnauthorized: true },
  );
  if (res.status === 401) {
    const answer = (await res.json().catch(() => ({}))) as { error?: string };
    if (answer.error === 'unauthenticated') sessionEnded();
    throw new ApiError('That is not your password.', 'invalid_credentials', 401);
  }
  if (res.status === 429) throw new ApiError(tooManyAttempts(await retryAfterOf(res)), 'too_many_attempts', 429);
  if (!res.ok) await failWith(res, fallback);
  return (await res.json()) as T;
}

/** Confirms the wallet addresses the manager reports for these nodes now, the only ones a transfer may go to. */
export function confirmFundingPins(password: string, nodeIds: string[]): Promise<FundingPinsAnswer> {
  const body: FundingPinsRequest = { password, nodeIds };
  return sendWithPassword(FUNDING_PINS_PATH, body, 'The addresses could not be confirmed.');
}

/** Sends these amounts from the brand wallet, one transfer each, and answers the bulk they went out under. */
export function sendFundingTransfers(
  password: string,
  items: FundingTransferItemRequest[],
): Promise<FundingTransfersAnswer> {
  const body: FundingTransfersRequest = { password, items };
  return sendWithPassword<FundingTransfersAnswer>(
    FUNDING_TRANSFERS_ADMIN_PATH,
    body,
    'The transfers could not be sent.',
  ).catch((e: unknown) => {
    if (e instanceof ApiError && e.code === 'conflict') throw new ApiError(EARLIER_SEND_SETTLING, e.code, e.status);
    throw e;
  });
}

/** What a send says when the API refuses it, 409 `conflict`, because an earlier one has not settled yet. */
export const EARLIER_SEND_SETTLING = 'An earlier send is still settling; check it again or wait.';

/** Where each transfer of a bulk stands, as the admin last heard from the manager. */
export async function fetchFundingTransfers(bulkId: string): Promise<FundingTransferItem[]> {
  return (await getJson<FundingBulkAnswer>(fundingBulkPath(bulkId))).items;
}

/**
 * Tops up or dilutes these batches, each paid for from its own node's wallet, and answers the stamp bulk they went out
 * under. No password: a stamp operation moves nothing out of the brand wallet, so the page asks in a confirm dialog.
 */
export function sendFundingStampOperations(items: StampOperationItemRequest[]): Promise<FundingStampOperationsAnswer> {
  const body: FundingStampOperationsRequest = { items };
  return sendJson<FundingStampOperationsAnswer>('POST', FUNDING_STAMP_OPERATIONS_ADMIN_PATH, body, {
    fallback: 'The stamp operations could not be sent.',
  }).catch((e: unknown) => {
    if (e instanceof ApiError && e.code === 'conflict') {
      throw new ApiError(EARLIER_STAMP_OPERATIONS_SETTLING, e.code, e.status);
    }
    throw e;
  });
}

/** What a stamp bulk says when the API refuses it, 409 `conflict`, because an earlier one has not settled yet. */
export const EARLIER_STAMP_OPERATIONS_SETTLING =
  'Earlier stamp operations are still settling; check them again or wait.';

/** Where each operation of a stamp bulk stands, as the admin last heard from the manager. */
export async function fetchFundingStampOperations(bulkId: string): Promise<FundingStampItem[]> {
  return (await getJson<FundingStampBulkAnswer>(fundingStampBulkPath(bulkId))).items;
}

/**
 * Brings these chequebooks to the target, each with a deposit from its own node's wallet or a withdrawal into it, and
 * answers the chequebook bulk they went out under, with the moves as the API journalled them. Each item names the
 * available balance the page showed, from which, and the balance it reads when the request comes in, the API works the
 * move out again, never more than the page showed. No password: nothing leaves the brand wallet, so the page asks in a
 * confirm dialog.
 */
export function sendFundingChequebookOperations(
  request: FundingChequebookOperationsRequest,
): Promise<FundingChequebookOperationsAnswer> {
  return sendJson<FundingChequebookOperationsAnswer>('POST', FUNDING_CHEQUEBOOK_OPERATIONS_ADMIN_PATH, request, {
    fallback: 'The chequebook operations could not be sent.',
  }).catch((e: unknown) => {
    if (e instanceof ApiError && e.code === 'conflict') {
      throw new ApiError(EARLIER_CHEQUEBOOK_OPERATIONS_SETTLING, e.code, e.status);
    }
    throw e;
  });
}

/** What a chequebook bulk says when the API refuses it, 409 `conflict`, because an earlier one has not settled yet. */
export const EARLIER_CHEQUEBOOK_OPERATIONS_SETTLING =
  'Earlier chequebook operations are still settling; check them again or wait.';

/** Where each operation of a chequebook bulk stands, as the admin last heard from the manager. */
export async function fetchFundingChequebookOperations(bulkId: string): Promise<FundingChequebookItem[]> {
  return (await getJson<FundingChequebookBulkAnswer>(fundingChequebookBulkPath(bulkId))).items;
}

// --- public config ----------------------------------------------------------

export function fetchPublicConfig(): Promise<PublicConfig> {
  return getJson<PublicConfig>(`${API}/config`);
}

// --- version ----------------------------------------------------------------

/** The build the API runs, as its deploy built it in. Behind the session, so a 401 here signs out like any other. */
export function fetchVersion(): Promise<VersionInfo> {
  return getJson<VersionInfo>(VERSION_PATH);
}
