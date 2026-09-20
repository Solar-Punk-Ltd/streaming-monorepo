import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, describe, it } from 'node:test';

import express from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createRequireInternalToken } from '../../src/api/middleware/requireInternalToken.js';
import { createInternalRuntimeRouter } from '../../src/api/routes/internalRuntime.js';
import type { ManagedIngestLifecycleConfig } from '../../src/utils/managedIngestConfig.js';

const TOKEN = 'synthetic-internal-token-000000000';
const running = new Set<http.Server>();

afterEach(async () => {
  await Promise.all([...running].map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  running.clear();
});

async function start(config: ManagedIngestLifecycleConfig | null): Promise<string> {
  const app = express();
  app.use('/api/internal', createRequireInternalToken(TOKEN), createInternalRuntimeRouter(config));
  app.use(errorHandler);
  const server = http.createServer(app);
  running.add(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function read(url: string, token?: string) {
  const response = await fetch(`${url}/api/internal/runtime/lifecycle`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() as unknown };
}

describe('internal running lifecycle assignment', () => {
  it('refuses missing and incorrect internal bearer tokens', async () => {
    const url = await start(null);

    assert.equal((await read(url)).status, 401);
    assert.equal((await read(url, 'synthetic-wrong-token-000000000')).status, 401);
  });

  it('reports the exact disabled and enabled process configurations', async () => {
    const disabled = await start(null);
    assert.deepEqual((await read(disabled, TOKEN)).body, {
      lifecycleVersion: null,
      uploaderId: null,
    });

    const enabled = await start({
      lifecycleVersion: 1,
      uploaderId: '11111111-1111-4111-8111-111111111111',
    });
    assert.deepEqual((await read(enabled, TOKEN)).body, {
      lifecycleVersion: 1,
      uploaderId: '11111111-1111-4111-8111-111111111111',
    });
  });
});
