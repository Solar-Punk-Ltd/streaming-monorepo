/**
 * Integration-test helpers: a thin HTTP client with one cookie jar for the
 * running web2-admin API. These tests talk to a LIVE backend (Postgres +
 * Express) over HTTP only — they import nothing from `src`, so they exercise
 * the real system exactly as the frontend does.
 *
 * Base URL is `WEB2_ADMIN_URL` (default http://localhost:9877); the login used
 * is `ADMIN_USERNAME` / `ADMIN_PASSWORD` (default admin / admin1234, the seed).
 */
import assert from 'node:assert/strict';

export const BASE = process.env.WEB2_ADMIN_URL ?? 'http://localhost:9877';
export const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? 'admin';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin1234';

/**
 * The bearer token of the API under test, for the /api/internal routes the
 * uploader calls. Must match the `INTERNAL_API_TOKEN` that instance booted
 * with; the default is the one test/integration/README tells you to start it
 * with.
 */
export const INTERNAL_API_TOKEN =
  process.env.INTERNAL_API_TOKEN ??
  'web2-admin-integration-internal-token-000000';

/**
 * Headers for an internal call: the bearer token, and `anonymous` so the
 * session cookie the rest of the suite holds is not sent with it. The internal
 * routes must answer on the token alone.
 */
export function internalCall(token = INTERNAL_API_TOKEN): RequestOptions {
  return { anonymous: true, headers: { authorization: `Bearer ${token}` } };
}

/** A 1x1 transparent PNG: the smallest real image to upload. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

export interface RawResponse {
  status: number;
  headers: Headers;
  /** The raw body; the thumbnail routes are the reason this is not just text. */
  bytes: Buffer;
  text: string;
  body: unknown;
}

/** The session cookie, kept across requests the way a browser would. */
let cookie: string | null = null;

export function sessionCookie(): string | null {
  return cookie;
}

export function forgetCookie(): void {
  cookie = null;
}

export interface RequestOptions {
  body?: unknown;
  raw?: Buffer;
  contentType?: string;
  /** Send no cookie, to check a route is actually behind requireAuth. */
  anonymous?: boolean;
  /** Extra headers, last word — for sending a cookie the jar would not hold. */
  headers?: Record<string, string>;
}

export async function raw(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = {};
  if (cookie && !options.anonymous) headers.cookie = cookie;

  let body: BodyInit | undefined;
  if (options.raw) {
    body = new Uint8Array(options.raw);
    headers['content-type'] = options.contentType ?? 'application/octet-stream';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = options.contentType ?? 'application/json';
  }

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...headers, ...options.headers },
    body,
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    const [pair] = setCookie.split(';');
    // An expiry in the past is the logout clearing it.
    cookie = /expires=Thu, 01 Jan 1970/i.test(setCookie) ? null : (pair ?? null);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString('utf8');
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    text,
    body: parsed,
  };
}

/** Request expecting a 2xx; fails with the server's body on anything else. */
export async function api<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await raw(method, path, options);
  assert.ok(
    response.status >= 200 && response.status < 300,
    `${method} ${path} -> ${response.status}: ${response.text}`,
  );
  return response.body as T;
}

export async function login(
  username = ADMIN_USERNAME,
  password = ADMIN_PASSWORD,
): Promise<void> {
  forgetCookie();
  await api('POST', '/api/auth/login', { body: { username, password } });
  assert.ok(sessionCookie(), 'login did not set a session cookie');
}

/** Fails loudly, once, when the API under test is not up. */
export async function requireStack(): Promise<void> {
  let response: RawResponse;
  try {
    response = await raw('GET', '/api/health', { anonymous: true });
  } catch (err) {
    assert.fail(
      `web2-admin API is not reachable at ${BASE} (${String(err)}).\n` +
        'Start it with: pnpm database:start && FEED_GATEWAY=fake pnpm dev',
    );
  }
  assert.equal(response.status, 200, `GET /api/health -> ${response.text}`);
}

/** Best-effort teardown: take the stream off the feed, then delete the row. */
export async function cleanup(streamIds: Iterable<string>): Promise<void> {
  for (const id of streamIds) {
    await raw('POST', `/api/streams/${id}/unpublish`);
    await raw('DELETE', `/api/streams/${id}`);
  }
}
