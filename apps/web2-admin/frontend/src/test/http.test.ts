import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
} from '@streaming-monorepo/web2-admin-common';

import { UNSUPPORTED_IMAGE_TYPE } from '../errors';
import {
  SessionEndedError,
  extractApiError,
  getJson,
  send,
  sendJson,
  setUnauthorizedHandler,
} from '../http';
import { jsonError, jsonOk, mockFetch } from './helpers';

describe('extractApiError', () => {
  it('puts validation errors first, they carry the only useful text', async () => {
    const res = jsonError(400, {
      error: 'validation_error',
      errors: ['title is a required field', 'tags must be at most 10 items'],
    });

    expect(await extractApiError(res, 'fallback')).toBe(
      'title is a required field; tags must be at most 10 items',
    );
  });

  it('prefers the console sentence over the backend message for a mapped code', async () => {
    // The backend's own message does not say which formats are allowed.
    const res = jsonError(415, {
      error: 'unsupported_media_type',
      message: 'content-type image/svg+xml is not allowed',
    });

    expect(await extractApiError(res, 'fallback')).toBe(
      UNSUPPORTED_IMAGE_TYPE,
    );
  });

  it('keeps the backend message for a code it has no sentence for', async () => {
    const res = jsonError(502, {
      error: 'publish_failed',
      message: 'bee feed write failed: 504',
    });

    expect(await extractApiError(res, 'fallback')).toBe(
      'bee feed write failed: 504',
    );
  });

  it('shows an unmapped code verbatim rather than swallowing it', async () => {
    const res = jsonError(409, { error: 'some_new_backend_code' });

    expect(await extractApiError(res, 'fallback')).toBe('some_new_backend_code');
  });

  it('falls back when the body is not JSON at all', async () => {
    const res = {
      ok: false,
      status: 413,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response;

    expect(await extractApiError(res, 'too big')).toBe('too big');
  });
});

describe('the cross-site header', () => {
  it('rides on every write, which is what makes one from another site fail', async () => {
    const fetchMock = mockFetch([
      { method: 'POST', path: '/api/auth/users', respond: () => jsonOk({}) },
      { method: 'DELETE', path: '/api/auth/users/u2', respond: () => jsonOk({}) },
    ]);

    await sendJson('POST', '/api/auth/users', { username: 'kim' });
    await send('DELETE', '/api/auth/users/u2');

    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers[REQUESTED_WITH_HEADER]).toBe(REQUESTED_WITH_VALUE);
    }
    expect(REQUESTED_WITH_VALUE).toBe('web2-admin');
  });

  it('is left off a read, which cannot change anything', async () => {
    const fetchMock = mockFetch([
      { path: '/api/streams', respond: () => jsonOk({ streams: [] }) },
    ]);

    await getJson('/api/streams');

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<
      string,
      string
    >;
    expect(headers[REQUESTED_WITH_HEADER]).toBeUndefined();
  });
});

describe('a 401', () => {
  afterEach(() => setUnauthorizedHandler(null));

  it('ends the session once, for the whole console', async () => {
    const onEnded = vi.fn();
    setUnauthorizedHandler(onEnded);
    mockFetch([
      {
        path: '/api/streams',
        respond: () => jsonError(401, { error: 'unauthenticated' }),
      },
    ]);

    await expect(getJson('/api/streams')).rejects.toBeInstanceOf(
      SessionEndedError,
    );
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('carries the sentence the login page shows for an ended session', async () => {
    setUnauthorizedHandler(vi.fn());
    mockFetch([
      {
        path: '/api/streams',
        respond: () => jsonError(401, { error: 'unauthenticated' }),
      },
    ]);

    await expect(getJson('/api/streams')).rejects.toThrow(
      'Your session ended. Log in again.',
    );
  });

  it('is left alone where it is an answer rather than an eviction', async () => {
    // The three routes that pass allowUnauthorized: the session probe, the
    // login form and the password change. Here: the probe.
    const onEnded = vi.fn();
    setUnauthorizedHandler(onEnded);
    mockFetch([
      {
        path: '/api/auth/session',
        respond: () => jsonError(401, { error: 'no_users' }),
      },
    ]);

    const { probeSession } = await import('../api');
    const probe = await probeSession();

    expect(probe).toEqual({ signedIn: false, reason: 'noUsers' });
    expect(onEnded).not.toHaveBeenCalled();
  });
});
