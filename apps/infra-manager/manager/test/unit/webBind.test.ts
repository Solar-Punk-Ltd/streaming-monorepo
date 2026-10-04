/**
 * Where the manager's console answers, read off its compose file.
 *
 * The console's web port defaults to the loopback address, where the host's
 * edge and an ssh tunnel reach it, and MANAGER_WEB_BIND names another address
 * for an operator who serves it some other way.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const compose = readFileSync(join(here, '..', '..', 'docker-compose.yml'), 'utf8');

describe("the console's web port", () => {
  it('is a setting, MANAGER_WEB_BIND, whose default is the loopback address', () => {
    assert.match(compose, /^ {6}- '\$\{MANAGER_WEB_BIND:-127\.0\.0\.1\}:\$\{WEB_PORT:-8080\}:80'$/m);
  });
});
