import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { INSPECTED_CONFIG_FIELDS, compareFileSystems, pickInspectedConfig } from '../image.mjs';
import { installFakeDocker } from './support/fake-docker.mjs';
import { makeTempDir, runScript } from './support/fixtures.mjs';
import { tarArchive, tarEntry } from './support/tar-builder.mjs';

const IMAGE = 'image.mjs';

const BEFORE = { name: 'app:before', id: `sha256:${'a'.repeat(64)}`, container: 'container-before' };
const AFTER = { name: 'app:after', id: `sha256:${'b'.repeat(64)}`, container: 'container-after' };

const BASE_CONFIG = {
  Entrypoint: ['docker-entrypoint.sh'],
  Cmd: ['node', 'dist/index.js'],
  Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_ENV=production'],
  User: '',
  ExposedPorts: { '9877/tcp': {} },
  WorkingDir: '/app',
  Healthcheck: null,
  Labels: null,
  Volumes: null,
  ArgsEscaped: true,
};

const BASE_FILES = {
  'app/': { type: '5', mode: 0o755 },
  'app/dist/index.js': { content: 'console.log(1)\n' },
  'app/node_modules/.modules.yaml': { content: 'prunedAt: Thu, 01 Jan 2026 00:00:00 GMT\n' },
};

function archiveOf(files) {
  return tarArchive(...Object.entries(files).map(([name, { content = '', ...fields }]) => tarEntry({ name, ...fields }, content)));
}

/** A stand-in docker that knows the two images, their containers and their exports. `first` replies win. */
function dockerWithImages(t, { beforeConfig = BASE_CONFIG, afterConfig = BASE_CONFIG, beforeFiles = BASE_FILES, afterFiles = BASE_FILES, first = [] } = {}) {
  const dir = makeTempDir(t, 'move-check-exports-');
  const beforeTar = join(dir, 'before.tar');
  const afterTar = join(dir, 'after.tar');
  writeFileSync(beforeTar, archiveOf(beforeFiles));
  writeFileSync(afterTar, archiveOf(afterFiles));
  return installFakeDocker(t, {
    replies: [
      ...first,
      { argsInclude: ['image', 'inspect', BEFORE.name], stdout: JSON.stringify([{ Id: BEFORE.id, Config: beforeConfig }]) },
      { argsInclude: ['image', 'inspect', AFTER.name], stdout: JSON.stringify([{ Id: AFTER.id, Config: afterConfig }]) },
      { argsInclude: ['create', BEFORE.id], stdout: `${BEFORE.container}\n` },
      { argsInclude: ['create', AFTER.id], stdout: `${AFTER.container}\n` },
      { argsInclude: ['export', BEFORE.container], stdoutFile: beforeTar },
      { argsInclude: ['export', AFTER.container], stdoutFile: afterTar },
      { argsInclude: ['rm'], stdout: '' },
    ],
  });
}

function removedContainers(docker) {
  return docker
    .calls()
    .filter((call) => call.args[0] === 'rm')
    .map((call) => call.args.at(-1));
}

const COMPARE = ['--before', BEFORE.name, '--after', AFTER.name];

describe('pickInspectedConfig', () => {
  it('picks the nine fields a container runs with and nothing else', () => {
    assert.deepEqual(INSPECTED_CONFIG_FIELDS, ['Entrypoint', 'Cmd', 'Env', 'User', 'ExposedPorts', 'WorkingDir', 'Healthcheck', 'Labels', 'Volumes']);
    const picked = pickInspectedConfig({ Id: 'x', Config: BASE_CONFIG });
    assert.deepEqual(Object.keys(picked), INSPECTED_CONFIG_FIELDS);
    assert.equal('ArgsEscaped' in picked, false);
  });

  it('reads a field the image does not set as null', () => {
    assert.equal(pickInspectedConfig({ Config: { Cmd: ['sh'] } }).Labels, null);
    assert.equal(pickInspectedConfig({}).Cmd, null);
  });
});

describe('compareFileSystems', () => {
  const entry = (path, extra = {}) => ({ path, type: 'file', mode: 0o644, uid: 0, gid: 0, size: 1, sha256: 'a'.repeat(64), ...extra });

  it('counts identical entries and lists what differs, field by field', () => {
    const comparison = compareFileSystems(
      [entry('same'), entry('content'), entry('mode'), entry('owner'), entry('gone'), entry('link', { type: 'symlink', size: 0, sha256: undefined, linkTarget: 'a' })],
      [
        entry('same'),
        entry('content', { size: 2, sha256: 'b'.repeat(64) }),
        entry('mode', { mode: 0o755 }),
        entry('owner', { uid: 1000 }),
        entry('new'),
        entry('link', { type: 'symlink', size: 0, sha256: undefined, linkTarget: 'b' }),
      ],
    );
    assert.equal(comparison.identical, 1);
    assert.deepEqual(
      comparison.changed.map((change) => [change.path, change.fields.map((field) => field.name)]),
      [
        ['content', ['size', 'sha256']],
        ['link', ['linkTarget']],
        ['mode', ['mode']],
        ['owner', ['owner']],
      ],
    );
    assert.deepEqual(comparison.missing.map((difference) => difference.path), ['gone']);
    assert.deepEqual(comparison.added.map((difference) => difference.path), ['new']);
  });
});

describe('image.mjs', () => {
  it('passes two images with the same config and file system on one line, and removes its containers', (t) => {
    const docker = dockerWithImages(t);
    const result = runScript(IMAGE, COMPARE, { env: docker.env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'image: match, 9 config fields equal, 3 identical filesystem entries\n');
    assert.deepEqual(removedContainers(docker).sort(), [AFTER.container, BEFORE.container]);
  });

  it('creates each container from the image id without pulling, and never starts one', (t) => {
    const docker = dockerWithImages(t);
    runScript(IMAGE, COMPARE, { env: docker.env });
    const calls = docker.calls();
    const creates = calls.filter((call) => call.args[0] === 'create');
    assert.equal(creates.length, 2);
    for (const create of creates) assert.deepEqual(create.args.slice(0, 3), ['create', '--pull', 'never']);
    assert.ok(creates[0].args.includes(BEFORE.id));
    assert.equal(calls.some((call) => ['start', 'run', 'pull', 'build'].includes(call.args[0])), false);
  });

  it('lists a file whose content changed with its size and digest', (t) => {
    const docker = dockerWithImages(t, { afterFiles: { ...BASE_FILES, 'app/dist/index.js': { content: 'console.log(22)\n' } } });
    const result = runScript(IMAGE, COMPARE, { env: docker.env });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^changed \(1\):$/m);
    assert.match(result.stdout, /^ {2}\/app\/dist\/index\.js {2}size 15 -> 16, sha256 [0-9a-f]{12} -> [0-9a-f]{12}$/m);
    assert.match(result.stdout, /^identical: 2$/m);
    assert.match(result.stdout, /^image: differs, 0 config differences and 1 filesystem difference not allowed$/m);
    assert.deepEqual(removedContainers(docker).sort(), [AFTER.container, BEFORE.container]);
  });

  it('lists a config field that differs with both values', (t) => {
    const afterConfig = { ...BASE_CONFIG, Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_ENV=development'] };
    const docker = dockerWithImages(t, { afterConfig });
    const result = runScript(IMAGE, COMPARE, { env: docker.env });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^Config\.Env\[1\]: before "NODE_ENV=production", after "NODE_ENV=development"$/m);
    assert.match(result.stdout, /^image: differs, 1 config difference and 0 filesystem differences not allowed$/m);
  });

  it('treats a config field the image leaves out the same as one set to null', (t) => {
    const { Labels, ...withoutLabels } = BASE_CONFIG;
    assert.equal(Labels, null);
    const docker = dockerWithImages(t, { afterConfig: withoutLabels });
    assert.equal(runScript(IMAGE, COMPARE, { env: docker.env }).status, 0);
  });

  it('lists missing and added paths and changes of mode, owner, type and link target', (t) => {
    const afterFiles = {
      'app/': { type: '5', mode: 0o700, uid: 1000 },
      'app/dist/index.js': { type: '2', linkname: 'main.js' },
      'app/new.js': { content: 'new\n' },
    };
    const docker = dockerWithImages(t, { afterFiles });
    const result = runScript(IMAGE, COMPARE, { env: docker.env });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^ {2}\/app {2}mode 0755 -> 0700, owner 0:0 -> 1000:0$/m);
    assert.match(result.stdout, /^ {2}\/app\/dist\/index\.js {2}type file -> symlink, size 15 -> 0, sha256 [0-9a-f]{12} -> \(none\), target \(none\) -> main\.js$/m);
    assert.match(result.stdout, /^missing \(1\):\n {2}\/app\/node_modules\/\.modules\.yaml$/m);
    assert.match(result.stdout, /^added \(1\):\n {2}\/app\/new\.js$/m);
  });

  it('lets a file system difference through when --allow names its path or a prefix of it', (t) => {
    const afterFiles = { ...BASE_FILES, 'app/node_modules/.modules.yaml': { content: 'prunedAt: Fri, 02 Jan 2026 00:00:00 GMT\n' } };
    const docker = dockerWithImages(t, { afterFiles });
    const exact = runScript(IMAGE, [...COMPARE, '--allow', '/app/node_modules/.modules.yaml'], { env: docker.env });
    assert.equal(exact.status, 0, exact.stdout);
    assert.equal(exact.stdout, 'image: match, 9 config fields equal, 2 identical filesystem entries, 1 allowed difference\n');
    assert.equal(runScript(IMAGE, [...COMPARE, '--allow', '/app/node_modules/'], { env: docker.env }).status, 0);
    const marked = runScript(IMAGE, [...COMPARE, '--allow', '/app/node_modules'], { env: docker.env });
    assert.equal(marked.status, 1);
  });

  describe('when the after image keeps a folder under another name', () => {
    const OLD_FOLDER = 'app/node_modules/.pnpm/common@file+web2-admin+common';
    const NEW_FOLDER = 'app/node_modules/.pnpm/common@file+common';
    const RENAME = ['--map', `/${OLD_FOLDER}=/${NEW_FOLDER}`];
    const withFolder = (folder, content) => ({ ...BASE_FILES, [`${folder}/`]: { type: '5', mode: 0o755 }, [`${folder}/index.js`]: { content } });

    it('compares the folder entry by entry under its new name when --map names the rename, and counts what it renamed', (t) => {
      const docker = dockerWithImages(t, { beforeFiles: withFolder(OLD_FOLDER, 'common\n'), afterFiles: withFolder(NEW_FOLDER, 'common\n') });

      const unmapped = runScript(IMAGE, COMPARE, { env: docker.env });
      assert.equal(unmapped.status, 1);
      assert.match(unmapped.stdout, /^missing \(2\):$/m);

      const mapped = runScript(IMAGE, [...COMPARE, ...RENAME], { env: docker.env });
      assert.equal(mapped.status, 0, mapped.stdout);
      assert.equal(mapped.stdout, 'image: match, 9 config fields equal, 5 identical filesystem entries, 2 entries renamed by --map\n');
    });

    it('still lists a file that changed inside the renamed folder, under its new path', (t) => {
      const docker = dockerWithImages(t, { beforeFiles: withFolder(OLD_FOLDER, 'common\n'), afterFiles: withFolder(NEW_FOLDER, 'changed\n') });

      const result = runScript(IMAGE, [...COMPARE, ...RENAME], { env: docker.env });

      assert.equal(result.status, 1);
      assert.match(result.stdout, /^ {2}\/app\/node_modules\/\.pnpm\/common@file\+common\/index\.js {2}size 7 -> 8, sha256 [0-9a-f]{12} -> [0-9a-f]{12}$/m);
      assert.match(result.stdout, /^image: differs, 0 config differences and 1 filesystem difference not allowed, 2 entries renamed by --map$/m);
    });

    it('exits 2 and removes both containers when --map sends two paths of the before image to one', (t) => {
      const beforeFiles = { ...BASE_FILES, 'app/old/x.js': { content: 'x\n' }, 'app/new/x.js': { content: 'x\n' } };
      const docker = dockerWithImages(t, { beforeFiles });

      const result = runScript(IMAGE, [...COMPARE, '--map', '/app/old=/app/new'], { env: docker.env });

      assert.equal(result.status, 2);
      assert.match(result.stderr, /--map sends both \/app\/(new|old)\/x\.js and \/app\/(new|old)\/x\.js to \/app\/new\/x\.js/);
      assert.deepEqual(removedContainers(docker).sort(), [AFTER.container, BEFORE.container]);
    });
  });

  describe('when something fails', () => {
    it('exits 2 and removes both containers when an export fails', (t) => {
      const docker = dockerWithImages(t, {
        first: [{ argsInclude: ['export', AFTER.container], stderr: 'Error response from daemon: export went wrong\n', status: 1 }],
      });
      const result = runScript(IMAGE, COMPARE, { env: docker.env });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--after/);
      assert.match(result.stderr, /export went wrong/);
      assert.equal(result.stdout, '');
      assert.deepEqual(removedContainers(docker).sort(), [AFTER.container, BEFORE.container]);
    });

    it('exits 2 and removes the first container when creating the second fails', (t) => {
      const docker = dockerWithImages(t, { first: [{ argsInclude: ['create', AFTER.id], stderr: 'no space left on device\n', status: 125 }] });
      const result = runScript(IMAGE, COMPARE, { env: docker.env });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /no space left on device/);
      assert.deepEqual(removedContainers(docker), [BEFORE.container]);
    });

    it('exits 2 before creating anything when an image is not local', (t) => {
      const docker = dockerWithImages(t, { first: [{ argsInclude: ['image', 'inspect', AFTER.name], stderr: 'Error: No such image: app:after\n', status: 1 }] });
      const result = runScript(IMAGE, COMPARE, { env: docker.env });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--after app:after/);
      assert.match(result.stderr, /No such image/);
      assert.equal(docker.calls().some((call) => call.args[0] === 'create'), false);
    });

    it('exits 2 and removes both containers when an export is not a tar stream', (t) => {
      const dir = makeTempDir(t, 'move-check-garbage-');
      const garbage = join(dir, 'garbage.tar');
      writeFileSync(garbage, Buffer.alloc(2048, 0x41));
      const docker = dockerWithImages(t, { first: [{ argsInclude: ['export', AFTER.container], stdoutFile: garbage }] });
      const result = runScript(IMAGE, COMPARE, { env: docker.env });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /could not be read as a tar stream/);
      assert.deepEqual(removedContainers(docker).sort(), [AFTER.container, BEFORE.container]);
    });

    it('exits 2 with the usage when --after is missing', () => {
      const result = runScript(IMAGE, ['--before', BEFORE.name]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--after is required/);
      assert.match(result.stderr, /Usage: node tools\/move-check\/image\.mjs/);
    });
  });
});
