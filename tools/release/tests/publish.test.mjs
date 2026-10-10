import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { gitEnv } from '../lib/git.mjs';
import { IMAGES, hashFolder, inputsOf } from '../publish.mjs';

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

/** A checkout with the two apps and the stack, and a docker that keeps a registry as a file of image references. */
function setup() {
  const root = temporary('release-publish-');
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...gitEnv(), GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
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
  writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
echo "$*" >> '${calls}'
case "$1 $2 $3" in
  "buildx imagetools inspect") grep -qxF "$4" '${registry}' ;;
  "buildx imagetools create") echo "$5" >> '${registry}' ;;
  build*) shift; while [ "$#" -gt 0 ]; do [ "$1" = --tag ] && echo "built $2" >> '${calls}'; shift; done ;;
  push*) echo "$2" >> '${registry}' ;;
  *) exit 9 ;;
esac
`);
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
  it('builds and uploads every image under the tag and under its inputs the first time', () => {
    const repo = setup();
    repo.git('tag', 'v1.0.0');
    const result = repo.publish('--tag', 'v1.0.0');
    assert.equal(result.status, 0, result.output);
    for (const image of IMAGES) {
      assert.ok(repo.pushed().includes(`registry.example/${image.name}:v1.0.0`), image.name);
      assert.ok(repo.pushed().some((ref) => ref.startsWith(`registry.example/${image.name}:inputs-`)), image.name);
    }
    assert.match(repo.called(), /--build-arg MANAGER_VERSION=v1\.0\.0/);
    assert.match(repo.called(), /--label streaming\.stack-commit=[0-9a-f]{40}/);
  });

  it('only tags the images of an app whose folder did not change, and builds the images of the one that did', () => {
    const repo = setup();
    repo.git('tag', 'v1.0.0');
    assert.equal(repo.publish('--tag', 'v1.0.0').status, 0);
    repo.write('apps/web2-admin/backend/src/index.ts', 'export const changed = true;\n');
    repo.git('commit', '-q', '-am', 'admin api changes');
    repo.git('tag', 'v1.1.0');
    repo.reset();
    const result = repo.publish('--tag', 'v1.1.0');
    assert.equal(result.status, 0, result.output);
    const built = repo.called().split('\n').filter((line) => line.startsWith('built ') && line.endsWith(':v1.1.0'));
    // An image's build context is its whole app folder, so both of the admin's images are built again.
    assert.deepEqual(built, ['built registry.example/streaming-admin-api:v1.1.0', 'built registry.example/streaming-admin-web:v1.1.0']);
    for (const image of IMAGES) assert.ok(repo.pushed().includes(`registry.example/${image.name}:v1.1.0`), image.name);
    assert.match(result.output, /streaming-manager-api: unchanged/);
    assert.match(result.output, /streaming-manager-web: unchanged/);
    assert.match(result.output, /streaming-admin-api: changed, built and uploaded/);
  });

  it('rebuilds the manager api when only the stack it deploys first changed', () => {
    const repo = setup();
    repo.git('tag', 'v1.0.0');
    assert.equal(repo.publish('--tag', 'v1.0.0').status, 0);
    repo.write('apps/hls-stream/deploy/docker-compose.yml', 'services: { changed: {} }\n');
    repo.git('commit', '-q', '-am', 'stack changes');
    repo.git('tag', 'v1.0.1');
    const result = repo.publish('--tag', 'v1.0.1');
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /streaming-manager-api: changed/);
    assert.match(result.output, /streaming-manager-web: unchanged/);
  });

  it('a dry run uploads and tags nothing', () => {
    const repo = setup();
    repo.git('tag', 'v1.0.0');
    const result = repo.publish('--tag', 'v1.0.0', '--dry-run');
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(repo.pushed(), []);
    assert.doesNotMatch(repo.called(), /^(build |push |buildx imagetools create )/m);
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

describe('the inputs of an image', () => {
  it('hash a folder by its paths and contents, whatever order they were written in', () => {
    const one = temporary('hash-one-');
    const two = temporary('hash-two-');
    writeFileSync(path.join(one, 'a'), '1');
    writeFileSync(path.join(one, 'b'), '2');
    writeFileSync(path.join(two, 'b'), '2');
    writeFileSync(path.join(two, 'a'), '1');
    assert.equal(hashFolder(one), hashFolder(two));
    writeFileSync(path.join(two, 'a'), '3');
    assert.notEqual(hashFolder(one), hashFolder(two));
  });

  it('count the stack commit for the manager api only', () => {
    const [api, web] = IMAGES;
    assert.notEqual(inputsOf(api, 'c', 'one'), inputsOf(api, 'c', 'two'));
    assert.equal(inputsOf(web, 'c', 'one'), inputsOf(web, 'c', 'two'));
  });
});
