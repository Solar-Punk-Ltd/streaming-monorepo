/**
 * Fetch wrappers for the web2-admin API. Every call is same-origin and
 * relative, so the session cookie rides along in dev (vite proxy) and in
 * production (nginx) without any CORS or token handling.
 */

import { mappedApiError } from './errors';

/** Registered by the auth provider; called on any unexpected 401. */
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export interface RequestOptions {
  /**
   * Set for the login endpoint, where a 401 means "wrong password" rather
   * than "your session went away" and must not trigger the global redirect.
   */
  expectUnauthorized?: boolean;
  /** Used when the failure carries no JSON body, as a 413 usually does. */
  fallback?: string;
}

export async function extractApiError(
  res: Response,
  fallback: string,
): Promise<string> {
  try {
    const err = (await res.json()) as {
      error?: string;
      message?: string;
      errors?: string[];
    };
    // `errors` first: that is where yup failures put the only useful text.
    // Reading `error` ahead of it shows the operator the literal string
    // "validation_error" and throws the reason away.
    if (err.errors?.length) return err.errors.join('; ');
    // The code beats `message` whenever the console has a sentence for it:
    // the backend's own message for, say, unsupported_media_type does not
    // tell the operator which formats to use, and ours does. An unmapped
    // code still yields to `message`, which is where publish_failed puts the
    // upstream reason.
    if (err.error) {
      const friendly = mappedApiError(err.error);
      if (friendly) return friendly;
    }
    if (err.message) return err.message;
    if (err.error) return err.error;
    return fallback;
  } catch {
    return fallback;
  }
}

async function request(
  path: string,
  init: RequestInit,
  options: RequestOptions = {},
): Promise<Response> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (res.status === 401 && !options.expectUnauthorized) {
    unauthorizedHandler?.();
  }
  if (!res.ok) {
    throw new Error(
      await extractApiError(
        res,
        options.fallback ?? `request failed (${res.status})`,
      ),
    );
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
