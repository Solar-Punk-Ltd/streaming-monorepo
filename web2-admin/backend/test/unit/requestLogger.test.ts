import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import type { NextFunction, Request, Response } from 'express';

import { requestLogger } from '../../src/api/middleware/requestLogger.js';

describe('request logging', () => {
  it('logs the path without private query values', () => {
    const sentinel = 'fixture-claim-sentinel-do-not-log';
    const request = {
      method: 'GET',
      path: '/api/internal/streams/fixture/runs/2',
      originalUrl:
        `/api/internal/streams/fixture/runs/2?uploaderId=fixture-uploader` +
        `&claimId=${sentinel}`,
    } as Request;
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
    }) as unknown as Response;
    const lines: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.join(' '));
    };
    try {
      requestLogger(request, response, (() => undefined) as NextFunction);
      response.emit('finish');
    } finally {
      console.info = originalInfo;
    }

    assert.equal(lines.length, 1);
    assert.match(lines[0], /GET \/api\/internal\/streams\/fixture\/runs\/2 200/);
    assert.doesNotMatch(lines[0], /\?/);
    assert.doesNotMatch(lines[0], new RegExp(sentinel));
  });
});
