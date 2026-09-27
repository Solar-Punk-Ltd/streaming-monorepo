import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { answeringRejections } from '../support/answeringRejections.js';

describe('a test server whose handler rejects', () => {
  it('answers 500 naming the error instead of leaving the request open', async (t) => {
    const server = createServer(
      answeringRejections(async () => {
        throw new Error('the body was not JSON');
      }),
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    const response = await fetch(`http://127.0.0.1:${address.port}/`, { signal: AbortSignal.timeout(2_000) });

    assert.equal(response.status, 500);
    assert.match(await response.text(), /the body was not JSON/);
  });
});
