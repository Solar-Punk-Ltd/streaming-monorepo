import { describe, expect, it } from 'vitest';

import { UNSUPPORTED_IMAGE_TYPE } from '../errors';
import { extractApiError } from '../http';
import { jsonError } from './helpers';

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
