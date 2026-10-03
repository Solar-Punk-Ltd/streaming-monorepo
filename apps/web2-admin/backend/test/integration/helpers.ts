/**
 * Integration-test helpers: a throwaway backend, and a thin HTTP client with
 * one cookie jar pointed at it.
 *
 * These tests talk to a LIVE backend (Postgres + Express) over HTTP only — they
 * import nothing from `src` but the harness that starts it, so they exercise
 * the real system exactly as the console does, cross-site header and all.
 *
 * The instance is the suite's own: its own database, its own port,
 * `FEED_GATEWAY=fake`, and a first user made with the `user:add` CLI. It is
 * never the development backend on :9877, which runs against a real Bee node
 * and the real catalogue and which this suite would publish through.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { stageRecordPath } from '@streaming-monorepo/contracts';
import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE } from '@streaming-monorepo/web2-admin-common';

import { STAGE_ID, stageRecord } from '../unit/support/stageFakes.js';

import { ITEST_INTERNAL_TOKEN, ITEST_PASSWORD, ITEST_USERNAME, startInstance, type Instance } from './instance.js';

export const ADMIN_USERNAME = ITEST_USERNAME;
export const ADMIN_PASSWORD = ITEST_PASSWORD;
export const INTERNAL_API_TOKEN = ITEST_INTERNAL_TOKEN;
/**
 * The own token of `STAGE_ID`'s uploader, for a suite that registers that stage with it: 64 hex characters, as the
 * manager generates one. The uploader's routes take nothing else, the registrar token included.
 */
export const UPLOADER_TOKEN = '3c'.repeat(32);

let instance: Instance | null = null;

/** Starts the backend under test, once per test process. */
export async function requireStack(): Promise<void> {
  if (!instance) instance = await startInstance();
}

/** Stops it and drops its database. Every suite calls this in `after`. */
export async function releaseStack(): Promise<void> {
  const running = instance;
  instance = null;
  forgetCookie();
  if (running) await running.stop();
}

export function stack(): Instance {
  if (!instance) throw new Error('the backend under test has not been started');
  return instance;
}

/**
 * Headers for an internal call: the bearer token, the registrar token unless
 * another is named, and `anonymous` so the session cookie the rest of the
 * suite holds is not sent with it. The internal routes must answer on the
 * token alone — and, since they sit ahead of the cross-site check, without the
 * header a browser would have to send.
 */
export function internalCall(token = INTERNAL_API_TOKEN): RequestOptions {
  return {
    anonymous: true,
    crossSiteHeader: false,
    headers: { authorization: `Bearer ${token}` },
  };
}

/** An internal call as a stage's uploader makes it: on its own token, `UPLOADER_TOKEN` unless another is named. */
export function uploaderCall(token = UPLOADER_TOKEN): RequestOptions {
  return internalCall(token);
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

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export interface RequestOptions {
  body?: unknown;
  raw?: Buffer;
  contentType?: string;
  /** Send no cookie, to check a route is actually behind requireAuth. */
  anonymous?: boolean;
  /** Left off to prove a write without it is refused as cross-site. */
  crossSiteHeader?: boolean;
  /** Extra headers, last word — for sending a cookie the jar would not hold. */
  headers?: Record<string, string>;
}

export async function raw(method: string, path: string, options: RequestOptions = {}): Promise<RawResponse> {
  const headers: Record<string, string> = {};
  if (cookie && !options.anonymous) headers.cookie = cookie;
  // What the console's fetch wrapper adds to every write, and what a page on
  // another site cannot add without a CORS preflight this API never answers.
  if (!SAFE_METHODS.has(method.toUpperCase()) && options.crossSiteHeader !== false) {
    headers[REQUESTED_WITH_HEADER] = REQUESTED_WITH_VALUE;
  }

  let body: BodyInit | undefined;
  if (options.raw) {
    body = new Uint8Array(options.raw);
    headers['content-type'] = options.contentType ?? 'application/octet-stream';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = options.contentType ?? 'application/json';
  }

  const response = await fetch(`${stack().url}${path}`, {
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
export async function api<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const response = await raw(method, path, options);
  assert.ok(
    response.status >= 200 && response.status < 300,
    `${method} ${path} -> ${response.status}: ${response.text}`,
  );
  return response.body as T;
}

export async function login(username = ADMIN_USERNAME, password = ADMIN_PASSWORD): Promise<void> {
  forgetCookie();
  await api('POST', '/api/auth/login', { body: { username, password } });
  assert.ok(sessionCookie(), 'login did not set a session cookie');
}

/** Best-effort teardown: take the stream off the feed, then delete the row. */
export async function cleanup(streamIds: Iterable<string>): Promise<void> {
  for (const id of streamIds) {
    await raw('POST', `/api/streams/${id}/unpublish`);
    await raw('DELETE', `/api/streams/${id}`);
  }
}

/**
 * Registers a stage the way the manager does, on the registrar token, so a
 * stream can be put on it and published: a draft with no stage is refused at
 * publish. Answers its id, `STAGE_ID` unless the record says otherwise.
 *
 * With `ownToken`, the record names that token, by its sha256, as the one the
 * stage's uploader presents, of its `own`, so an uploader call on it is
 * attributed to the stage. Without, the record's `adminToken` is what `over`
 * says, or the fixture's.
 */
export async function registerStage(over: Parameters<typeof stageRecord>[0] = {}, ownToken?: string): Promise<string> {
  const record = stageRecord({
    stageId: STAGE_ID,
    ...over,
    ...(ownToken === undefined
      ? {}
      : { adminToken: { sha256: createHash('sha256').update(ownToken, 'utf8').digest('hex'), kind: 'own' as const } }),
  });
  const stored = await raw('PUT', stageRecordPath(record.stageId), { ...internalCall(), body: record });
  assert.equal(stored.status, 200, stored.text);
  return record.stageId;
}
