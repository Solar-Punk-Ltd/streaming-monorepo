import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { writeIfPasswordUnchanged, type CredentialClient } from './credentialWrite.js';

const VERIFIED = 'scrypt$verified';

/** A pool of one client that records every statement and answers the row lock with `stored`. */
function recordingPool(stored: string | undefined, failOn?: RegExp) {
  const statements: string[] = [];
  let released = 0;
  const client: CredentialClient = {
    async query(text: string) {
      statements.push(text);
      if (failOn?.test(text)) throw new Error('synthetic write failure');
      if (/FOR UPDATE/.test(text)) return { rows: stored === undefined ? [] : [{ password_hash: stored }] };
      return { rows: [] };
    },
    release() {
      released += 1;
    },
  };
  return {
    pool: { connect: async () => client },
    statements,
    released: () => released,
  };
}

const WRITE = 'UPDATE users SET something';

describe('a credential write guarded by the password it verified', () => {
  it('writes and commits under the row lock while the stored hash is the verified one', async () => {
    const { pool, statements, released } = recordingPool(VERIFIED);

    const written = await writeIfPasswordUnchanged(pool, 'user-1', VERIFIED, async (client) => {
      await client.query(WRITE);
    });

    assert.equal(written, true);
    assert.deepEqual(statements, [
      'BEGIN',
      'SELECT password_hash FROM users WHERE id = $1 FOR UPDATE',
      WRITE,
      'COMMIT',
    ]);
    assert.equal(released(), 1);
  });

  it('writes nothing and answers false once the password has moved', async () => {
    const { pool, statements, released } = recordingPool('scrypt$replaced');

    const written = await writeIfPasswordUnchanged(pool, 'user-1', VERIFIED, async (client) => {
      await client.query(WRITE);
    });

    assert.equal(written, false);
    assert.equal(statements.includes(WRITE), false);
    assert.equal(statements.at(-1), 'COMMIT');
    assert.equal(released(), 1);
  });

  it('writes nothing and answers false when the user is gone', async () => {
    const { pool, statements } = recordingPool(undefined);

    assert.equal(await writeIfPasswordUnchanged(pool, 'user-1', VERIFIED, async () => {}), false);
    assert.equal(statements.at(-1), 'COMMIT');
  });

  it('rolls back, releases the client and passes the error on when a write fails', async () => {
    const { pool, statements, released } = recordingPool(VERIFIED, /^UPDATE/);

    await assert.rejects(
      writeIfPasswordUnchanged(pool, 'user-1', VERIFIED, async (client) => {
        await client.query(WRITE);
      }),
      /synthetic write failure/,
    );

    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.equal(statements.includes('COMMIT'), false);
    assert.equal(released(), 1);
  });
});
