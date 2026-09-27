/**
 * The two answers of the error handler another app reads by their code. Unit
 * test, the handler only, with stand-ins for Express's request and response.
 *
 * The stream uploader takes a 404 on an ingest lookup as nobody having declared
 * the stream, and the manager's Test connection tells the admin's own 404 and
 * 401 from any other server's by the `error` code alone. So the status and the
 * code of both are pinned here as the literals those readers compare with.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Request, Response } from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { StreamNotFoundError, UnauthenticatedError } from '../../src/domain/errors/index.js';

function answer(err: unknown): { status: number; body: unknown } {
  const sent = { status: 0, body: undefined as unknown };
  const res = {
    headersSent: false,
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      return res;
    },
  };
  errorHandler(err, {} as Request, res as unknown as Response, () => undefined);
  return sent;
}

describe('the error handler, where another app reads the code', () => {
  it('answers a stream nobody declared with 404 and stream_not_found', () => {
    assert.deepEqual(answer(new StreamNotFoundError('video/00000000-0000-0000-0000-000000000000')), {
      status: 404,
      body: { error: 'stream_not_found', id: 'video/00000000-0000-0000-0000-000000000000' },
    });
  });

  it('answers a request without a token it takes with 401 and unauthenticated', () => {
    assert.deepEqual(answer(new UnauthenticatedError()), { status: 401, body: { error: 'unauthenticated' } });
  });
});
