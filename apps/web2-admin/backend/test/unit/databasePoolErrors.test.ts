/**
 * What happens to the process when a pooled connection dies on its own.
 *
 * node-postgres hands an idle client's failure to the pool as an 'error'
 * event, and an EventEmitter with no listener for that event throws what it
 * was given. Nothing is awaiting such a failure, so the throw has nowhere to
 * land and the process ends. Postgres restarting under a running admin is that
 * event.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Database } from '../../src/domain/Database.js';

const NEVER_CONNECTED = 'postgres://admin:admin@127.0.0.1:1/admin';

describe('a pooled connection that dies while nothing is using it', () => {
  it('does not end the process that opened the pool', async () => {
    const database = new Database(NEVER_CONNECTED);
    try {
      assert.doesNotThrow(() => {
        database.pool.emit('error', new Error('Connection terminated unexpectedly'));
      });
    } finally {
      await database.close();
    }
  });
});
