import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { installFakeDocker } from './support/fake-docker.mjs';
import { commitAll, makeRepo, makeTempDir, runScript, writeFiles } from './support/fixtures.mjs';
import { tarArchive, tarEntry } from './support/tar-builder.mjs';

const IMAGES = 'images.mjs';

/** Enough added files that image.mjs's report runs past the 1 MiB a child process's output gets by default. */
const LARGE_DIFFERENCE_FILES = 20_000;

/** A build that outlasts the cut-off, and a cut-off long enough for the first pair to be compared under load. */
const SLOW_BUILD_MS = 60_000;
const CUT_OFF_MS = 15_000;

const CONFIG = {
  Entrypoint: null,
  Cmd: ['node', 'app.js'],
  Env: ['PATH=/usr/local/bin:/usr/bin:/bin'],
  User: '',
  ExposedPorts: null,
  WorkingDir: '/app',
  Healthcheck: null,
  Labels: null,
  Volumes: null,
};

const FILES = {
  'app/': { type: '5', mode: 0o755 },
  'app/app.js': { content: 'console.log(1)\n' },
  'app/node_modules/.modules.yaml': { content: 'prunedAt: Thu, 01 Jan 2026 00:00:00 GMT\n' },
};

/** A project at the root of a repository, then the same project moved under apps/demo, as a subtree import leaves it. */
function movedProject(t) {
  const repo = makeRepo(t);
  writeFiles(repo, { Dockerfile: 'FROM scratch\nCOPY app.js /app/app.js\n', 'app.js': 'console.log(1)\n' });
  const before = commitAll(repo, 'the project at the root');
  rmSync(join(repo, 'Dockerfile'));
  rmSync(join(repo, 'app.js'));
  writeFiles(repo, {
    'apps/demo/Dockerfile': 'FROM scratch\nCOPY app.js /app/app.js\n',
    'apps/demo/app.js': 'console.log(1)\n',
    'README.md': 'another project beside it\n',
  });
  const after = commitAll(repo, 'the project in apps/demo');
  return { repo, before, after };
}

function demoImage(before, after, overrides = {}) {
  return {
    name: 'demo',
    before: { commit: before, context: '.', dockerfile: 'Dockerfile' },
    after: { commit: after, context: 'apps/demo', dockerfile: 'apps/demo/Dockerfile' },
    allow: ['/app/node_modules/.modules.yaml'],
    ...overrides,
  };
}

function manifestFile(t, images) {
  const path = join(makeTempDir(t, 'move-check-manifest-'), 'images.json');
  writeFileSync(path, JSON.stringify({ images }, null, 2));
  return path;
}

function archiveOf(files) {
  return tarArchive(...Object.entries(files).map(([name, { content = '', ...fields }]) => tarEntry({ name, ...fields }, content)));
}

/**
 * A stand-in docker that builds every tag it is asked for and answers image.mjs about the images `images`
 * names, each side with its own files. `first` replies win over the rest.
 */
function dockerFor(t, images, { first = [] } = {}) {
  const dir = makeTempDir(t, 'move-check-images-exports-');
  const replies = [
    ...first,
    { argsInclude: ['build'], stdout: '' },
    { argsInclude: ['builder', 'prune'], stdout: '' },
    { argsInclude: ['rm'], stdout: '' },
  ];
  images.forEach(({ name, beforeFiles = FILES, afterFiles = FILES }, index) => {
    for (const [side, files] of [['before', beforeFiles], ['after', afterFiles]]) {
      const tag = `move-check-images/${name}:${side}`;
      const id = `sha256:${String(index)}${side === 'before' ? 'a' : 'b'}`.padEnd(71, '0');
      const container = `container-${name}-${side}`;
      const tar = join(dir, `${name}-${side}.tar`);
      writeFileSync(tar, archiveOf(files));
      replies.push(
        { argsInclude: ['image', 'inspect', tag], stdout: JSON.stringify([{ Id: id, Config: CONFIG }]) },
        { argsInclude: ['create', id], stdout: `${container}\n` },
        { argsInclude: ['export', container], stdoutFile: tar },
      );
    }
  });
  return installFakeDocker(t, { replies });
}

function builds(docker) {
  return docker.calls().filter((call) => call.args[0] === 'build');
}

/** The folder `--keep` left the exports in, removed when the test ends. */
function keptExports(t, stdout) {
  const match = /kept the exports in (\S+)/.exec(stdout);
  assert.ok(match, `no kept exports line in:\n${stdout}`);
  t.after(() => rmSync(match[1], { recursive: true, force: true }));
  return match[1];
}

describe('images.mjs builds each image from both commits and compares them', () => {
  it('builds each side from an export of its own commit, without the build cache, and says they match', (t) => {
    const { repo, before, after } = movedProject(t);
    const docker = dockerFor(t, [{ name: 'demo' }]);

    const result = runScript(IMAGES, ['--manifest', manifestFile(t, [demoImage(before, after)]), '--keep'], { cwd: repo, env: docker.env });

    assert.equal(result.status, 0, result.stderr);
    const kept = keptExports(t, result.stdout);
    const [beforeBuild, afterBuild] = builds(docker);
    assert.deepEqual(beforeBuild.args, [
      'build', '--no-cache', '--file', join(kept, before, 'Dockerfile'), '--tag', 'move-check-images/demo:before', join(kept, before),
    ]);
    assert.deepEqual(afterBuild.args, [
      'build', '--no-cache', '--file', join(kept, after, 'apps/demo/Dockerfile'), '--tag', 'move-check-images/demo:after', join(kept, after, 'apps/demo'),
    ]);
    assert.equal(readFileSync(join(kept, before, 'app.js'), 'utf8'), 'console.log(1)\n');
    assert.equal(existsSync(join(kept, before, 'apps')), false, 'the before export is its own commit');
    assert.equal(readFileSync(join(kept, after, 'apps/demo/app.js'), 'utf8'), 'console.log(1)\n');
    assert.match(result.stdout, /^demo: image: match/m);
    assert.match(result.stdout, /^images: 1 compared, 1 match$/m);
  });

  it('removes the exports when it is done, unless told to keep them', (t) => {
    const { repo, before, after } = movedProject(t);
    const docker = dockerFor(t, [{ name: 'demo' }]);

    const result = runScript(IMAGES, ['--manifest', manifestFile(t, [demoImage(before, after)])], { cwd: repo, env: docker.env });

    assert.equal(result.status, 0, result.stderr);
    for (const build of builds(docker)) assert.equal(existsSync(build.args.at(-1)), false, build.args.at(-1));
  });

  it('removes each pair of images and the build cache once the pair is compared, when asked, and never otherwise', (t) => {
    const { repo, before, after } = movedProject(t);
    const docker = dockerFor(t, [{ name: 'demo' }, { name: 'other' }]);
    const manifest = manifestFile(t, [demoImage(before, after), demoImage(before, after, { name: 'other' })]);

    const kept = runScript(IMAGES, ['--manifest', manifest], { cwd: repo, env: docker.env });
    assert.equal(kept.status, 0, kept.stderr);
    assert.equal(docker.calls().some((call) => call.args[0] === 'image' && call.args[1] === 'rm'), false, 'the images stay for a person to inspect');
    const firstRunCalls = docker.calls().length;

    const removed = runScript(IMAGES, ['--manifest', manifest, '--remove-images'], { cwd: repo, env: docker.env });
    assert.equal(removed.status, 0, removed.stderr);
    const cleanups = docker.calls().filter((call) => (call.args[0] === 'image' && call.args[1] === 'rm') || call.args[0] === 'builder');
    assert.deepEqual(cleanups.map((call) => call.args), [
      ['image', 'rm', '--force', 'move-check-images/demo:before', 'move-check-images/demo:after'],
      ['builder', 'prune', '--force'],
      ['image', 'rm', '--force', 'move-check-images/other:before', 'move-check-images/other:after'],
      ['builder', 'prune', '--force'],
    ]);
    const calls = docker.calls().slice(firstRunCalls).map((call) => call.args.join(' '));
    assert.ok(
      calls.indexOf('image rm --force move-check-images/demo:before move-check-images/demo:after') < calls.indexOf(calls.find((call) => call.includes('move-check-images/other:before') && call.startsWith('build'))),
      'a pair is removed before the next pair is built',
    );
  });

  it('lets a difference the manifest allows through', (t) => {
    const { repo, before, after } = movedProject(t);
    const afterFiles = { ...FILES, 'app/node_modules/.modules.yaml': { content: 'prunedAt: Fri, 02 Jan 2026 00:00:00 GMT\n' } };
    const docker = dockerFor(t, [{ name: 'demo', afterFiles }]);

    const result = runScript(IMAGES, ['--manifest', manifestFile(t, [demoImage(before, after)])], { cwd: repo, env: docker.env });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^demo: image: match, .*1 allowed difference$/m);
  });

  it('reports a difference too long for a default output buffer as a difference, with its whole listing', (t) => {
    const { repo, before, after } = movedProject(t);
    const afterFiles = { ...FILES };
    for (let index = 0; index < LARGE_DIFFERENCE_FILES; index += 1) {
      afterFiles[`app/generated/a-file-with-a-long-enough-name-${String(index).padStart(5, '0')}.js`] = { content: 'x\n' };
    }
    const docker = dockerFor(t, [{ name: 'demo', afterFiles }]);

    const result = runScript(IMAGES, ['--manifest', manifestFile(t, [demoImage(before, after)])], { cwd: repo, env: docker.env });

    assert.equal(result.status, 1, `${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`);
    assert.doesNotMatch(result.stdout, /could not be checked/);
    assert.match(result.stdout, /a-file-with-a-long-enough-name-19999\.js/, 'the last difference is in the listing');
  });

  it("runs each side's prepare commands in its context before building it, as a deploy script builds first", (t) => {
    const { repo, before, after } = movedProject(t);
    const docker = dockerFor(t, [{ name: 'demo' }]);
    const prepare = [[process.execPath, '-e', "require('node:fs').writeFileSync('prepared.txt', 'built\\n')"]];
    const image = demoImage(before, after, {
      before: { commit: before, context: '.', dockerfile: 'Dockerfile', prepare },
      after: { commit: after, context: 'apps/demo', dockerfile: 'apps/demo/Dockerfile', prepare },
    });

    const result = runScript(IMAGES, ['--manifest', manifestFile(t, [image]), '--keep'], { cwd: repo, env: docker.env });
    keptExports(t, result.stdout);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(builds(docker).length, 2);
    for (const build of builds(docker)) assert.equal(existsSync(join(build.args.at(-1), 'prepared.txt')), true, build.args.at(-1));
  });

  it('stops with 2 when a prepare command fails, naming the side, and builds nothing of that pair', (t) => {
    const { repo, before, after } = movedProject(t);
    const docker = dockerFor(t, [{ name: 'demo' }]);
    const image = demoImage(before, after, {
      before: { commit: before, context: '.', dockerfile: 'Dockerfile', prepare: [[process.execPath, '-e', 'process.exit(3)']] },
    });

    const result = runScript(IMAGES, ['--manifest', manifestFile(t, [image])], { cwd: repo, env: docker.env });

    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^demo: could not be checked: the before prepare failed/m);
    assert.equal(builds(docker).length, 0);
  });

  it('refuses a prepare that is not a list of commands, before anything is built', (t) => {
    const { repo, before, after } = movedProject(t);
    const docker = dockerFor(t, [{ name: 'demo' }]);
    const image = demoImage(before, after, { before: { commit: before, context: '.', dockerfile: 'Dockerfile', prepare: 'pnpm build' } });

    const result = runScript(IMAGES, ['--manifest', manifestFile(t, [image])], { cwd: repo, env: docker.env });

    assert.equal(result.status, 2);
    assert.match(result.stderr + result.stdout, /prepare is a list of commands/);
    assert.equal(builds(docker).length, 0);
  });

  it('prints each pair as it is compared, so a run cut off later keeps the verdicts it reached', (t) => {
    const { repo, before, after } = movedProject(t);
    const docker = dockerFor(t, [{ name: 'demo' }, { name: 'other' }], {
      first: [{ argsInclude: ['build', 'move-check-images/other:before'], stdout: '', sleepMs: SLOW_BUILD_MS }],
    });
    const manifest = manifestFile(t, [demoImage(before, after), demoImage(before, after, { name: 'other' })]);

    const result = runScript(IMAGES, ['--manifest', manifest], { cwd: repo, env: docker.env, timeoutMs: CUT_OFF_MS });

    assert.equal(result.signal, 'SIGTERM', 'the run was cut off during the second pair');
    assert.match(result.stdout, /^demo: .*match/m, 'the first pair was already reported');
  });

  it('reports an image that differs with what image.mjs found, and exits 1', (t) => {
    const { repo, before, after } = movedProject(t);
    const afterFiles = { ...FILES, 'app/app.js': { content: 'console.log(2)\n' } };
    const docker = dockerFor(t, [{ name: 'demo', afterFiles }]);

    const result = runScript(IMAGES, ['--manifest', manifestFile(t, [demoImage(before, after)])], { cwd: repo, env: docker.env });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^demo: image: differs/m);
    assert.match(result.stdout, /^ {4}\/app\/app\.js {2}sha256/m, 'the changed file is named, under its image');
    assert.match(result.stdout, /^images: 1 compared, 0 match, 1 differs$/m);
  });

  it('stops with 2 when a build fails, naming the image and the side, and still checks the rest', (t) => {
    const { repo, before, after } = movedProject(t);
    const docker = dockerFor(t, [{ name: 'demo' }, { name: 'other' }], {
      first: [{ argsInclude: ['build', 'move-check-images/demo:after'], status: 1, stderr: 'ERROR: failed to solve: a step failed\n' }],
    });
    const manifest = manifestFile(t, [demoImage(before, after), demoImage(before, after, { name: 'other' })]);

    const result = runScript(IMAGES, ['--manifest', manifest], { cwd: repo, env: docker.env });

    assert.equal(result.status, 2);
    assert.match(result.stdout, /^demo: could not be checked: the after build failed/m);
    assert.match(result.stdout, /failed to solve: a step failed/);
    assert.match(result.stdout, /^other: image: match/m);
    assert.match(result.stdout, /^images: 2 compared, 1 match, 1 could not be checked$/m);
  });
});

describe('images.mjs reads its manifest strictly', () => {
  it('plans every build without building anything, having found every commit, context and Dockerfile', (t) => {
    const { repo, before, after } = movedProject(t);
    const docker = dockerFor(t, []);

    const result = runScript(IMAGES, ['--manifest', manifestFile(t, [demoImage(before, after)]), '--plan'], { cwd: repo, env: docker.env });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(builds(docker).length, 0);
    assert.match(result.stdout, new RegExp(`before ${before}: docker build --no-cache --file Dockerfile --tag move-check-images/demo:before \\.`));
    assert.match(result.stdout, new RegExp(`after ${after}: docker build --no-cache --file apps/demo/Dockerfile --tag move-check-images/demo:after apps/demo`));
    assert.match(result.stdout, /^images: plan, 1 image, 2 builds, every commit, context and Dockerfile found$/m);
  });

  it('refuses a plan whose Dockerfile or context is not in its commit, naming it', (t) => {
    const { repo, before, after } = movedProject(t);
    const docker = dockerFor(t, []);
    const manifest = manifestFile(t, [demoImage(before, after, { after: { commit: before, context: 'apps/demo', dockerfile: 'apps/demo/Dockerfile' } })]);

    const result = runScript(IMAGES, ['--manifest', manifest, '--plan'], { cwd: repo, env: docker.env });

    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`demo after: ${before} has no apps/demo`));
  });

  it('refuses a manifest entry that could leave the repository, or names no commit, before building', (t) => {
    const { repo, before, after } = movedProject(t);
    const docker = dockerFor(t, []);
    const broken = [
      demoImage(before, after, { before: { commit: before, context: '../outside', dockerfile: 'Dockerfile' } }),
      demoImage(before, after, { after: { commit: after, context: 'apps/demo', dockerfile: '/etc/Dockerfile' } }),
      demoImage(before, after, { before: { commit: 'not-a-commit', context: '.', dockerfile: 'Dockerfile' } }),
      demoImage(before, after, { name: 'Demo Image' }),
      demoImage(before, after, { allow: 'app/node_modules/.modules.yaml' }),
    ];

    for (const entry of broken) {
      const result = runScript(IMAGES, ['--manifest', manifestFile(t, [entry])], { cwd: repo, env: docker.env });
      assert.equal(result.status, 2, JSON.stringify(entry));
      assert.notEqual(result.stderr, '', JSON.stringify(entry));
    }
    assert.equal(builds(docker).length, 0);
  });

  it('refuses two images of one name', (t) => {
    const { repo, before, after } = movedProject(t);
    const docker = dockerFor(t, []);

    const result = runScript(IMAGES, ['--manifest', manifestFile(t, [demoImage(before, after), demoImage(before, after)])], { cwd: repo, env: docker.env });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /demo is named twice/);
  });

  it('runs only the images --only names, and refuses a name the manifest does not have', (t) => {
    const { repo, before, after } = movedProject(t);
    const docker = dockerFor(t, [{ name: 'other' }]);
    const manifest = manifestFile(t, [demoImage(before, after), demoImage(before, after, { name: 'other' })]);

    const only = runScript(IMAGES, ['--manifest', manifest, '--only', 'other'], { cwd: repo, env: docker.env });
    assert.equal(only.status, 0, only.stderr);
    assert.deepEqual(builds(docker).map((call) => call.args[5]), ['move-check-images/other:before', 'move-check-images/other:after']);

    const unknown = runScript(IMAGES, ['--manifest', manifest, '--only', 'missing'], { cwd: repo, env: docker.env });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /--only missing names no image in the manifest/);
  });
});
