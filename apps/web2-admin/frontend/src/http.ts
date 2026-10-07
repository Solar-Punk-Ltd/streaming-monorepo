/**
 * Fetch wrappers for the web2-admin API. Every call is same-origin and
 * relative, so the session cookie rides along in dev (vite proxy) and in
 * production (nginx) without any CORS or token handling.
 *
 * Two things every request gets here, both ported from the manager's
 * `frontend/src/http.ts`. A header no cross-origin page can set without a CORS
 * preflight the API never answers, which is what makes a write from another
 * site impossible even with the cookie attached. And one place where a 401
 * turns into "you are signed out" for the whole console, so a session that
 * ended between two clicks lands on the login page instead of a toast that
 * says nothing useful.
 */

import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE } from '@streaming-monorepo/web2-admin-common';

import { SIGN_IN_MESSAGES } from './authMessages';
import { mappedApiError } from './errors';

/** Neither can change anything, so neither needs the cross-site header. */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** Registered by the auth provider; called on any unexpected 401. */
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/** A refusal the API explained: its error code travels with the message. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The 401 that evicted the session, as opposed to the 401 that was an answer.
 * Thrown so a caller can tell "you are no longer signed in" from "that request
 * was refused" — signing out, for one, treats it as a job already done.
 */
export class SessionEndedError extends ApiError {
  constructor() {
    super(SIGN_IN_MESSAGES.sessionEnded, 'unauthenticated', 401);
    this.name = 'SessionEndedError';
  }
}

/**
 * Ends the session in the console, as an unexpected 401 does, for a caller that took the 401 itself: one of the
 * password routes, where a 401 is a wrong password unless the API says the session ended.
 */
export function sessionEnded(): never {
  unauthorizedHandler?.();
  throw new SessionEndedError();
}

export interface RequestOptions {
  /**
   * For the routes where a 401 is the answer to the question asked rather than
   * a session that has ended: `/auth/session`, which answers 401 to say nobody
   * is signed in or that no user exists yet; `/auth/login`, where it means the
   * pair was wrong; and `/auth/password`, where it means the *current*
   * password was wrong, not that the session went away. Everywhere else a 401
   * evicts, because there is nothing else it can mean.
   */
  allowUnauthorized?: boolean;
  /** Used when the failure carries no JSON body, as a 413 usually does. */
  fallback?: string;
}

/**
 * The one door out of the console. Returns the response untouched; only a 401
 * that is not expected is turned into a sign-out and an error.
 */
export async function apiFetch(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  // A plain record rather than a Headers instance: the whole console reads
  // these back in tests, and a record is what the other wrappers pass in.
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  if (!SAFE_METHODS.has(method)) {
    headers[REQUESTED_WITH_HEADER] = REQUESTED_WITH_VALUE;
  }

  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers,
  });

  if (res.status === 401 && !options.allowUnauthorized) {
    unauthorizedHandler?.();
    throw new SessionEndedError();
  }

  return res;
}

interface ApiFailure {
  message: string;
  code: string | null;
}

async function readFailure(res: Response, fallback: string): Promise<ApiFailure> {
  try {
    const err = (await res.json()) as {
      error?: string;
      message?: string;
      errors?: string[];
    };
    const code = err.error ?? null;
    // `errors` first: that is where yup failures put the only useful text.
    // Reading `error` ahead of it shows the operator the literal string
    // "validation_error" and throws the reason away.
    if (err.errors?.length) return { message: err.errors.join('; '), code };
    // The code beats `message` whenever the console has a sentence for it:
    // the backend's own message for, say, unsupported_media_type does not
    // tell the operator which formats to use, and ours does. An unmapped
    // code still yields to `message`, which is where publish_failed puts the
    // upstream reason.
    if (err.error) {
      const friendly = mappedApiError(err.error);
      if (friendly) return { message: friendly, code };
    }
    if (err.message) return { message: err.message, code };
    if (err.error) return { message: err.error, code };
    return { message: fallback, code };
  } catch {
    return { message: fallback, code: null };
  }
}

export async function extractApiError(res: Response, fallback: string): Promise<string> {
  return (await readFailure(res, fallback)).message;
}

/** Throws with whatever the API said went wrong, code and status attached. */
export async function failWith(res: Response, fallback: string): Promise<never> {
  const failure = await readFailure(res, fallback);
  throw new ApiError(failure.message, failure.code, res.status);
}

async function request(path: string, init: RequestInit, options: RequestOptions = {}): Promise<Response> {
  const res = await apiFetch(path, init, options);
  if (!res.ok) {
    await failWith(res, options.fallback ?? `request failed (${res.status})`);
  }
  return res;
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await request(path, { method: 'GET' });
  return (await res.json()) as T;
}

export async function sendJson<T>(
  method: 'POST' | 'PUT' | 'PATCH',
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  const res = await request(
    path,
    {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    },
    options,
  );
  return (await res.json()) as T;
}

/** Raw image bytes for the thumbnail endpoints, content type from the file. */
export async function sendBytes<T>(
  path: string,
  body: Blob,
  contentType: string,
  options?: RequestOptions,
): Promise<T> {
  const res = await request(
    path,
    {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body,
    },
    options,
  );
  return (await res.json()) as T;
}

export async function sendDelete<T>(path: string): Promise<T | null> {
  const res = await request(path, { method: 'DELETE' });
  // 204 for stream deletion, a Stream body for thumbnail deletion.
  if (res.status === 204) return null;
  return (await res.json()) as T;
}

export async function sendEmpty(path: string): Promise<void> {
  await request(path, { method: 'POST' });
}

/**
 * A write whose answer the console does not read. The auth writes answer 201,
 * 204 or a body depending on the route, and none of them is worth parsing.
 */
export async function send(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<void> {
  await request(
    path,
    body === undefined
      ? { method }
      : {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
    options,
  );
}
