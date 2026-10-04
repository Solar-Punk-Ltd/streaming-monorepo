/**
 * Where the manager's database can be reached from.
 *
 * The compose file a server runs publishes no database port. The api reaches
 * Postgres by service name on the project network, so a host that already runs
 * a Postgres of its own on 5432 can still bring the manager up. A developer who
 * runs `pnpm dev` on the host gets the port from the development override, on
 * loopback, at MANAGER_DEV_PG_PORT with 5432 as its default.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const managerDir = join(here, '..', '..');
const compose = readFileSync(join(managerDir, 'docker-compose.yml'), 'utf8');
const devCompose = readFileSync(join(managerDir, 'docker-compose.dev.yml'), 'utf8');
const scripts = (
  JSON.parse(readFileSync(join(managerDir, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
).scripts;

/** The lines of one top-level service block, up to the next service. */
function serviceBlock(text: string, service: string): string {
  const start = text.indexOf(`\n  ${service}:\n`);
  assert.notEqual(start, -1, `no ${service} service`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n|\n[a-z]/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('the manager database port', () => {
  it('is not published by the compose file a server runs', () => {
    assert.doesNotMatch(serviceBlock(compose, 'postgres'), /^\s+ports:/m);
  });

  it('is published on loopback by the development override, at a port the developer can set', () => {
    assert.match(serviceBlock(devCompose, 'postgres'), /- '127\.0\.0\.1:\$\{MANAGER_DEV_PG_PORT:-5432\}:5432'/);
  });

  it('is published for the development scripts that start the database on the host', () => {
    for (const name of ['database:start', 'database:stop', 'stack:start', 'stack:stop']) {
      assert.match(scripts[name] ?? '', /-f \.\/docker-compose\.yml -f \.\/docker-compose\.dev\.yml/, name);
    }
  });
});
