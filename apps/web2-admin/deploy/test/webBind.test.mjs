import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Where the admin console answers, read off its compose file. It defaults to the loopback address,
 * where the host's edge and an ssh tunnel reach it, and WEB2_ADMIN_WEB_BIND names another address for
 * an operator who serves it some other way.
 */
const compose = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'docker-compose.yml'), 'utf8');

describe("the console's web port", () => {
  it('is a setting, WEB2_ADMIN_WEB_BIND, whose default is the loopback address', () => {
    assert.match(compose, /^ {6}- '\$\{WEB2_ADMIN_WEB_BIND:-127\.0\.0\.1\}:\$\{WEB2_ADMIN_WEB_PORT:-9090\}:80'$/m);
  });
});
