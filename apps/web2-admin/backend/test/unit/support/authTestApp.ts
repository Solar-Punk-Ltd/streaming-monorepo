/**
 * The console's gate on a random port, wired exactly as `src/api/server.ts`
 * wires it: /api/internal first with its own body parser, the cross-site check
 * over everything after it and ahead of the JSON parser, /api/health,
 * /api/auth and the session gate behind them.
 *
 * `/api/streams` here stands in for the rest of the API. It answers with the
 * signed-in username so a test can tell a real pass from an accidental one.
 */
import http from 'node:http';

import {
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  SESSION_COOKIE_NAME,
} from '@streaming-monorepo/web2-admin-common';
import express from 'express';

import { errorHandler } from '../../../src/api/middleware/errorHandler.js';
import { notFound } from '../../../src/api/middleware/notFound.js';
import { createRequireAuth, requireUser } from '../../../src/api/middleware/requireAuth.js';
import { createRequireInternalToken } from '../../../src/api/middleware/requireInternalToken.js';
import { requireSameSite } from '../../../src/api/middleware/requireSameSite.js';
import { createAuthRouter } from '../../../src/api/routes/auth.js';
import { AuthService } from '../../../src/domain/auth/AuthService.js';
import type { LoginLimiter } from '../../../src/domain/auth/LoginLimiter.js';

import { InMemoryCredentialRepository, InMemorySessionRepository, InMemoryUserRepository } from './authFixtures.js';

/** The token the harness's stand-in uploader route accepts. */
export const INTERNAL_TOKEN = 'test-internal-token-0000000000000000';

export interface AuthTestApp {
  url: string;
  authService: AuthService;
  users: InMemoryUserRepository;
  sessions: InMemorySessionRepository;
  close(): Promise<void>;
}

export async function startAuthTestApp(limiter?: LoginLimiter): Promise<AuthTestApp> {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const authService = new AuthService(users, sessions, new InMemoryCredentialRepository(users, sessions), limiter);
  const requireAuth = createRequireAuth(authService);

  const app = express();
  const json = express.json({ limit: '256kb' });

  // The uploader's surface, mounted the way server.ts mounts it: ahead of the
  // cross-site check, with a bearer token and a body parser of its own.
  app.post('/api/internal/ping', json, createRequireInternalToken(INTERNAL_TOKEN), (req, res) => {
    res.json({ ok: true, body: req.body as unknown });
  });

  app.use(requireSameSite);
  app.use(json);

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/api/auth', createAuthRouter(authService, requireAuth));

  app.use(requireAuth);
  app.get('/api/streams', (req, res) => {
    res.json({ user: requireUser(req).user.username });
  });
  app.post('/api/streams', (req, res) => {
    res.status(201).json({ user: requireUser(req).user.username });
  });

  app.use(notFound);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not report a port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    authService,
    users,
    sessions,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export interface CallOptions {
  body?: unknown;
  rawBody?: string;
  cookie?: string | null;
  /** Left off to prove a write without it is refused. */
  requestedWith?: boolean;
  headers?: Record<string, string>;
}

export interface CallResult {
  status: number;
  body: unknown;
  setCookie: string[];
  retryAfter: string | null;
}

export async function call(
  app: AuthTestApp,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<CallResult> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined || options.rawBody !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (options.requestedWith !== false) {
    headers[REQUESTED_WITH_HEADER] = REQUESTED_WITH_VALUE;
  }
  if (options.cookie) headers.cookie = options.cookie;

  const res = await fetch(`${app.url}${path}`, {
    method,
    headers: { ...headers, ...options.headers },
    body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });

  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* a non-JSON body is reported as the raw text */
  }

  return {
    status: res.status,
    body,
    setCookie: res.headers.getSetCookie(),
    retryAfter: res.headers.get('retry-after'),
  };
}

/** The `web2_admin_session=<token>` pair from a Set-Cookie list, or null. */
export function sessionCookieFrom(setCookie: string[]): string | null {
  const header = setCookie.find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`));
  const pair = header?.split(';')[0];
  return pair && !pair.endsWith('=') ? pair : null;
}

export function tokenFrom(cookiePair: string): string {
  return cookiePair.slice(`${SESSION_COOKIE_NAME}=`.length);
}

export interface SignedIn {
  cookie: string;
  token: string;
}

/** Signs in over HTTP and hands back the cookie the browser would keep. */
export async function signIn(app: AuthTestApp, username: string, password: string): Promise<SignedIn> {
  const res = await call(app, 'POST', '/api/auth/login', {
    body: { username, password },
  });
  if (res.status !== 200) {
    throw new Error(`sign-in failed with ${res.status}: ${JSON.stringify(res.body)}`);
  }

  const cookie = sessionCookieFrom(res.setCookie);
  if (!cookie) throw new Error('sign-in set no session cookie');
  return { cookie, token: tokenFrom(cookie) };
}
