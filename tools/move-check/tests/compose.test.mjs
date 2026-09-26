import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parsePrefixMaps } from '../lib/shared.mjs';
import { composeArguments, normalizeComposeConfig } from '../compose.mjs';
import { installFakeDocker } from './support/fake-docker.mjs';
import { TEST_ENV, makeTempDir, runScript, writeFiles } from './support/fixtures.mjs';

const COMPOSE = 'compose.mjs';

function service(overrides = {}) {
  return { image: 'postgres:16-alpine', restart: 'unless-stopped', ...overrides };
}

/** Two checkouts, each holding the given compose files, with their real paths. */
function makeCheckouts(t, beforeFiles = { 'deploy/docker-compose.yml': 'services: {}\n' }, afterFiles = beforeFiles) {
  const before = makeTempDir(t, 'move-check-before-');
  const after = makeTempDir(t, 'move-check-after-');
  writeFiles(before, beforeFiles);
  writeFiles(after, afterFiles);
  return { before, after, beforeReal: realpathSync(before), afterReal: realpathSync(after) };
}

function renders(checkouts, beforeConfig, afterConfig = beforeConfig) {
  return [
    { argsInclude: ['compose', 'config'], cwd: checkouts.beforeReal, stdout: JSON.stringify(beforeConfig) },
    { argsInclude: ['compose', 'config'], cwd: checkouts.afterReal, stdout: JSON.stringify(afterConfig) },
  ];
}

describe('composeArguments', () => {
  it('renders the file as JSON, ignoring any .env file next to it', () => {
    assert.deepEqual(composeArguments({ file: 'deploy/docker-compose.yml' }), [
      'compose',
      '--env-file',
      '/dev/null',
      '-f',
      'deploy/docker-compose.yml',
      'config',
      '--format',
      'json',
    ]);
  });

  it('names the project only when one is given', () => {
    assert.deepEqual(composeArguments({ file: 'c.yml', project: 'demo' }).slice(0, 3), ['compose', '-p', 'demo']);
  });
});

describe('normalizeComposeConfig', () => {
  const roots = ['/work/before'];

  it('rewrites a build context under the checkout relative to it', () => {
    const config = { services: { api: { build: { context: '/work/before', dockerfile: 'web2-admin/backend/Dockerfile' } } } };
    assert.deepEqual(normalizeComposeConfig(config, roots).services.api.build, {
      context: '.',
      dockerfile: 'web2-admin/backend/Dockerfile',
    });
  });

  it('resolves a Dockerfile against its context before making it relative', () => {
    const config = { services: { api: { build: { context: '/work/before/web2-admin', dockerfile: 'backend/Dockerfile' } } } };
    assert.deepEqual(normalizeComposeConfig(config, roots).services.api.build, {
      context: 'web2-admin',
      dockerfile: 'web2-admin/backend/Dockerfile',
    });
  });

  it('rewrites an absolute Dockerfile under the checkout', () => {
    const config = { services: { api: { build: { context: '/work/before', dockerfile: '/work/before/docker/Dockerfile' } } } };
    assert.equal(normalizeComposeConfig(config, roots).services.api.build.dockerfile, 'docker/Dockerfile');
  });

  it('rewrites a bind-mount source and leaves the container path and a named volume alone', () => {
    const config = {
      services: {
        db: {
          volumes: [
            { type: 'bind', source: '/work/before/deploy/data', target: '/data' },
            { type: 'volume', source: 'pg-data', target: '/var/lib/postgresql/data' },
          ],
        },
      },
    };
    assert.deepEqual(normalizeComposeConfig(config, roots).services.db.volumes, [
      { type: 'bind', source: 'deploy/data', target: '/data' },
      { type: 'volume', source: 'pg-data', target: '/var/lib/postgresql/data' },
    ]);
  });

  it('leaves a path that only shares its first characters with the checkout', () => {
    const config = { services: { api: { volumes: [{ type: 'bind', source: '/work/before-other/x', target: '/x' }] } } };
    assert.equal(normalizeComposeConfig(config, roots).services.api.volumes[0].source, '/work/before-other/x');
  });

  it('knows the checkout by each of its names, such as a symlink and its target', () => {
    const config = { services: { api: { build: { context: '/private/work/before/app', dockerfile: 'Dockerfile' } } } };
    const normalized = normalizeComposeConfig(config, ['/work/before', '/private/work/before']);
    assert.deepEqual(normalized.services.api.build, { context: 'app', dockerfile: 'app/Dockerfile' });
  });

  it('applies the maps to rewritten paths only', () => {
    const config = {
      services: {
        api: {
          build: { context: '/work/before', dockerfile: 'web2-admin/backend/Dockerfile' },
          labels: { component: 'web2-admin/backend' },
        },
      },
    };
    const normalized = normalizeComposeConfig(config, roots, parsePrefixMaps(['web2-admin=apps/web2-admin']));
    assert.equal(normalized.services.api.build.dockerfile, 'apps/web2-admin/backend/Dockerfile');
    assert.equal(normalized.services.api.labels.component, 'web2-admin/backend');
  });

  it('does not change the config it was given', () => {
    const config = { services: { api: { build: { context: '/work/before', dockerfile: 'Dockerfile' } } } };
    const copy = structuredClone(config);
    normalizeComposeConfig(config, roots);
    assert.deepEqual(config, copy);
  });
});

describe('compose.mjs', () => {
  it('passes two equal renders on one line', (t) => {
    const checkouts = makeCheckouts(t);
    const config = { name: 'deploy', services: { postgres: service(), api: service({ image: 'api' }) } };
    const docker = installFakeDocker(t, { replies: renders(checkouts, config) });
    const args = ['--before', checkouts.before, '--after', checkouts.after, '--file', 'deploy/docker-compose.yml'];
    const result = runScript(COMPOSE, args, { env: docker.env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'compose: match, the same config for 2 services on both sides\n');
  });

  it('lists each differing JSON path with the value on each side', (t) => {
    const checkouts = makeCheckouts(t);
    const before = { services: { postgres: service() } };
    const after = { services: { postgres: service({ image: 'postgres:17-alpine', ports: [{ target: 5432 }] }) } };
    const docker = installFakeDocker(t, { replies: renders(checkouts, before, after) });
    const args = ['--before', checkouts.before, '--after', checkouts.after, '--file', 'deploy/docker-compose.yml'];
    const result = runScript(COMPOSE, args, { env: docker.env });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^services\.postgres\.image: before "postgres:16-alpine", after "postgres:17-alpine"$/m);
    assert.match(result.stdout, /^services\.postgres\.ports: before \(absent\), after \[\{"target":5432\}\]$/m);
    assert.match(result.stdout, /^compose: differs at 2 JSON paths$/m);
  });

  it('passes a moved stack once the maps rename its paths', (t) => {
    const checkouts = makeCheckouts(t, { 'deploy/docker-compose.yml': 'x' }, { 'apps/web2-admin/deploy/docker-compose.yml': 'x' });
    const render = (prefix) => ({
      services: {
        api: {
          build: { context: '{{cwd}}', dockerfile: `${prefix}web2-admin/backend/Dockerfile` },
          volumes: [{ type: 'bind', source: `{{cwd}}/${prefix}${prefix ? 'web2-admin/' : ''}deploy/data`, target: '/data' }],
        },
      },
    });
    const docker = installFakeDocker(t, {
      replies: [
        { argsInclude: ['compose', 'config'], cwd: checkouts.beforeReal, stdout: JSON.stringify(render('')) },
        { argsInclude: ['compose', 'config'], cwd: checkouts.afterReal, stdout: JSON.stringify(render('apps/')) },
      ],
    });
    const args = [
      '--before', checkouts.before,
      '--after', checkouts.after,
      '--before-file', 'deploy/docker-compose.yml',
      '--after-file', 'apps/web2-admin/deploy/docker-compose.yml',
      '--map', 'web2-admin=apps/web2-admin',
      '--map', 'deploy=apps/web2-admin/deploy',
    ];
    const result = runScript(COMPOSE, args, { env: docker.env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const [beforeCall, afterCall] = docker.calls();
    assert.equal(beforeCall.cwd, checkouts.beforeReal);
    assert.ok(beforeCall.args.includes('deploy/docker-compose.yml'));
    assert.equal(afterCall.cwd, checkouts.afterReal);
    assert.ok(afterCall.args.includes('apps/web2-admin/deploy/docker-compose.yml'));
  });

  it('runs both sides under one project name only when --project is given', (t) => {
    const checkouts = makeCheckouts(t);
    const docker = installFakeDocker(t, { replies: renders(checkouts, { services: {} }) });
    const common = ['--before', checkouts.before, '--after', checkouts.after, '--file', 'deploy/docker-compose.yml'];
    assert.equal(runScript(COMPOSE, common, { env: docker.env }).status, 0);
    assert.equal(runScript(COMPOSE, [...common, '--project', 'demo'], { env: docker.env }).status, 0);
    const calls = docker.calls();
    assert.equal(calls[0].args.includes('-p'), false);
    assert.equal(calls[1].args.includes('-p'), false);
    assert.deepEqual(calls[2].args.slice(0, 3), ['compose', '-p', 'demo']);
    assert.deepEqual(calls[3].args.slice(0, 3), ['compose', '-p', 'demo']);
  });

  it('hands every --env value to both renders', (t) => {
    const checkouts = makeCheckouts(t);
    const docker = installFakeDocker(t, { replies: renders(checkouts, { services: {} }), recordEnv: ['POSTGRES_PASSWORD', 'WEB2_ADMIN_ENV_FILE'] });
    const args = [
      '--before', checkouts.before,
      '--after', checkouts.after,
      '--file', 'deploy/docker-compose.yml',
      '--env', 'POSTGRES_PASSWORD=placeholder',
      '--env', 'WEB2_ADMIN_ENV_FILE=/dev/null',
    ];
    assert.equal(runScript(COMPOSE, args, { env: docker.env }).status, 0);
    for (const call of docker.calls()) {
      assert.deepEqual(call.env, { POSTGRES_PASSWORD: 'placeholder', WEB2_ADMIN_ENV_FILE: '/dev/null' });
    }
  });

  it('exits 2 and quotes compose when a render fails', (t) => {
    const checkouts = makeCheckouts(t);
    const docker = installFakeDocker(t, {
      replies: [
        { argsInclude: ['compose', 'config'], cwd: checkouts.beforeReal, stdout: '{}' },
        { argsInclude: ['compose', 'config'], cwd: checkouts.afterReal, stderr: 'required variable POSTGRES_PASSWORD is missing a value\n', status: 15 },
      ],
    });
    const args = ['--before', checkouts.before, '--after', checkouts.after, '--file', 'deploy/docker-compose.yml'];
    const result = runScript(COMPOSE, args, { env: docker.env });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--after/);
    assert.match(result.stderr, /required variable POSTGRES_PASSWORD is missing a value/);
  });

  it('exits 2 when compose prints something that is not JSON', (t) => {
    const checkouts = makeCheckouts(t);
    const docker = installFakeDocker(t, { replies: [{ argsInclude: ['compose', 'config'], stdout: 'services:\n' }] });
    const args = ['--before', checkouts.before, '--after', checkouts.after, '--file', 'deploy/docker-compose.yml'];
    const result = runScript(COMPOSE, args, { env: docker.env });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not JSON/);
  });

  describe('bad usage', () => {
    it('exits 2 when no side has a compose file', (t) => {
      const checkouts = makeCheckouts(t);
      const result = runScript(COMPOSE, ['--before', checkouts.before, '--after', checkouts.after, '--before-file', 'a.yml']);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--file/);
      assert.match(result.stderr, /Usage: node tools\/move-check\/compose\.mjs/);
    });

    it('exits 2 when --after is missing', (t) => {
      const checkouts = makeCheckouts(t);
      const result = runScript(COMPOSE, ['--before', checkouts.before, '--file', 'deploy/docker-compose.yml']);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--after is required/);
    });

    it('exits 2 for an --env without an equals sign', (t) => {
      const checkouts = makeCheckouts(t);
      const args = ['--before', checkouts.before, '--after', checkouts.after, '--file', 'x.yml', '--env', 'POSTGRES_PASSWORD'];
      const result = runScript(COMPOSE, args);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--env takes <KEY>=<VALUE>/);
    });

    it('exits 2 for a checkout that does not exist', (t) => {
      const checkouts = makeCheckouts(t);
      const missing = join(checkouts.before, 'no-such-dir');
      const result = runScript(COMPOSE, ['--before', missing, '--after', checkouts.after, '--file', 'x.yml']);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--before .*no-such-dir is not a directory/);
    });
  });

  it('proves a real move with docker compose itself', (t) => {
    const probe = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
    if (probe.status !== 0) {
      t.skip('docker compose is not installed here, so the real render was not tried');
      return;
    }
    const composeFile = (context, dockerfile) =>
      [
        'services:',
        '  api:',
        '    image: example/api:${API_TAG:-default}',
        '    build:',
        `      context: ${context}`,
        `      dockerfile: ${dockerfile}`,
        '    environment:',
        '      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD:?set it}@postgres:5432/app',
        '    volumes:',
        '      - ./data:/data',
        '',
      ].join('\n');
    // Only the before checkout has a .env next to its compose file. Were it read, API_TAG would differ.
    const checkouts = makeCheckouts(
      t,
      { 'deploy/docker-compose.yml': composeFile('..', 'web2-admin/backend/Dockerfile'), 'deploy/.env': 'API_TAG=from-a-dotenv-file\n' },
      { 'apps/web2-admin/deploy/docker-compose.yml': composeFile('../../..', 'apps/web2-admin/backend/Dockerfile') },
    );
    const args = [
      '--before', checkouts.before,
      '--after', checkouts.after,
      '--before-file', 'deploy/docker-compose.yml',
      '--after-file', 'apps/web2-admin/deploy/docker-compose.yml',
      '--env', 'POSTGRES_PASSWORD=placeholder',
      '--map', 'web2-admin=apps/web2-admin',
      '--map', 'deploy=apps/web2-admin/deploy',
    ];
    const result = runScript(COMPOSE, args, { env: TEST_ENV });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, 'compose: match, the same config for 1 service on both sides\n');
  });
});
