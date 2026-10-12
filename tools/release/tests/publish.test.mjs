import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { gitEnv } from '../lib/git.mjs';
import { IMAGES } from '../publish.mjs';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const SCRIPT = fileURLToPath(new URL('../publish.mjs', import.meta.url));
const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function temporary(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * A checkout with the two apps and the stack, and a docker that keeps a registry as a file of image references. It
 * answers `buildx imagetools` as a registry would, so a publish that tried to reuse an image would be seen doing it.
 */
function setup() {
  const root = temporary('release-publish-');
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...gitEnv(),
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    }).trim();
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  git('init', '-q', '-b', 'main');
  for (const image of IMAGES) write(path.join(image.app, image.dockerfile), `FROM scratch # ${image.name}\n`);
  write('apps/infra-manager/manager/src/index.ts', 'export {};\n');
  write('apps/web2-admin/backend/src/index.ts', 'export {};\n');
  write('apps/hls-stream/deploy/docker-compose.yml', 'services: {}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');

  const bin = temporary('release-publish-bin-');
  const registry = path.join(bin, 'registry');
  const calls = path.join(bin, 'calls');
  writeFileSync(registry, '');
  writeFileSync(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash
echo "$*" >> '${calls}'
case "$1" in
  buildx) [ "$3" = inspect ] && grep -qxF "$4" '${registry}' || { [ "$3" = create ] && echo "$5" >> '${registry}'; } ;;
  build) shift; while [ "$#" -gt 0 ]; do [ "$1" = --tag ] && echo "built $2" >> '${calls}'; shift; done ;;
  push) echo "$2" >> '${registry}' ;;
  *) exit 9 ;;
esac
`,
  );
  chmodSync(path.join(bin, 'docker'), 0o755);

  const publish = (...args) => {
    const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--registry', 'registry.example', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    return { ...result, output: `${result.stdout}${result.stderr}` };
  };
  const pushed = () => readFileSync(registry, 'utf8').split('\n').filter(Boolean);
  const called = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');
  const reset = () => writeFileSync(calls, '');
  return { root, git, write, publish, pushed, called, reset };
}

describe('publish.mjs', () => {
  it('builds and uploads every image under the tag', () => {
    const repo = setup();
    repo.git('tag', 'v1.0.0');
    const result = repo.publish('--tag', 'v1.0.0');
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(
      repo.pushed(),
      IMAGES.map((image) => `registry.example/${image.name}:v1.0.0`),
    );
    assert.match(repo.called(), /--build-arg MANAGER_VERSION=v1\.0\.0/);
    assert.match(repo.called(), /--label streaming\.stack-commit=[0-9a-f]{40}/);
  });

  it('builds every image again for a release that changed only one app, so each carries the version of its tag', () => {
    const repo = setup();
    repo.git('tag', 'v1.0.0');
    assert.equal(repo.publish('--tag', 'v1.0.0').status, 0);
    repo.write('apps/web2-admin/backend/src/index.ts', 'export const changed = true;\n');
    repo.git('commit', '-q', '-am', 'admin api changes');
    repo.git('tag', 'v1.1.0');
    repo.reset();
    const result = repo.publish('--tag', 'v1.1.0');
    assert.equal(result.status, 0, result.output);
    const built = repo
      .called()
      .split('\n')
      .filter((line) => line.startsWith('built '));
    assert.deepEqual(
      built,
      IMAGES.map((image) => `built registry.example/${image.name}:v1.1.0`),
    );
    assert.match(repo.called(), /--build-arg MANAGER_VERSION=v1\.1\.0/);
    assert.doesNotMatch(repo.called(), /imagetools/);
    for (const image of IMAGES)
      assert.match(result.output, new RegExp(`${image.name}: built and uploaded as v1\\.1\\.0`));
  });

  it('a dry run uploads nothing and names every image it would build', () => {
    const repo = setup();
    repo.git('tag', 'v1.0.0');
    const result = repo.publish('--tag', 'v1.0.0', '--dry-run');
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(repo.pushed(), []);
    assert.equal(repo.called(), '');
    for (const image of IMAGES)
      assert.match(result.output, new RegExp(`${image.name}: would be built and uploaded as v1\\.0\\.0`));
  });

  it('refuses a tag an image cannot carry, a missing tag, and a checkout away from the tag', () => {
    const repo = setup();
    assert.match(repo.publish('--tag', 'manager/v2').output, /cannot be an image tag/);
    assert.match(repo.publish('--tag', 'v9.9.9').output, /there is no tag v9\.9\.9/);
    repo.git('tag', 'v1.0.0');
    repo.write('apps/web2-admin/backend/src/index.ts', 'export const later = true;\n');
    repo.git('commit', '-q', '-am', 'later');
    const away = repo.publish('--tag', 'v1.0.0');
    assert.notEqual(away.status, 0);
    assert.match(away.output, /not at v1\.0\.0/);
    assert.deepEqual(repo.pushed(), []);
  });
});
