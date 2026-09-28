import type {
  AddUserRequest,
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

export function logout(): Promise<void> {
  return sendEmpty(`${API}/auth/logout`);
}

/**
 * A 401 here means the current password was wrong, not that the session has
 * gone, so it is answered rather than turned into a sign-out.
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

export async function fetchCatalogueStamp(): Promise<CatalogueStampSummary | null> {
  const body = await getJson<CatalogueStampResponse>(`${API}/catalogue-stamp`);
  return body.catalogueStamp;
}

/** What the next catalogue write does: the batch it goes through, why it is refused, and a move that is waiting. */
export async function fetchCatalogueWrite(): Promise<CatalogueWriteStatus> {
  const body = await getJson<CatalogueStampResponse>(`${API}/catalogue-stamp`);
  return body.catalogueWrite;
}

// --- public config ----------------------------------------------------------

export function fetchPublicConfig(): Promise<PublicConfig> {
  return getJson<PublicConfig>(`${API}/config`);
}
