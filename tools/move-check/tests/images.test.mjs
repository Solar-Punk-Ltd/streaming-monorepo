import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { installFakeDocker } from './support/fake-docker.mjs';
import { commitAll, makeRepo, makeTempDir, runScript, writeFiles } from './support/fixtures.mjs';
import { tarArchive, tarEntry } from './support/tar-builder.mjs';

const IMAGES = 'images.mjs';
const MANIFEST = 'images.json';
const DOCKERFILE = 'FROM scratch\nCOPY app.js /app/app.js\n';

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

/** The demo image as a manifest names it, built from apps/demo. */
function demoImage(overrides = {}) {
  return { name: 'demo', context: 'apps/demo', dockerfile: 'apps/demo/Dockerfile', allow: ['/app/build-stamp.txt'], ...overrides };
}

function manifestText(images) {
  return `${JSON.stringify({ images }, null, 2)}\n`;
}

/** Writes a manifest into the working tree, or removes it for `null`. */
function writeManifest(repo, images) {
  if (images === null) rmSync(join(repo, MANIFEST), { force: true });
  else writeFiles(repo, { [MANIFEST]: manifestText(images) });
}

/**
 * A repository whose base holds the demo project, and whose head changes something beside it, as most pull requests
 * do. Each side's manifest can be given, and `null` leaves that side without one.
 */
function projectRepo(t, { baseImages = [demoImage()], headImages = baseImages } = {}) {
  const repo = makeRepo(t);
  writeFiles(repo, { 'apps/demo/Dockerfile': DOCKERFILE, 'apps/demo/app.js': 'console.log(1)\n' });
  writeManifest(repo, baseImages);
  const base = commitAll(repo, 'the base');
  writeFiles(repo, { 'README.md': 'a change beside the image\n' });
  writeManifest(repo, headImages);
  const head = commitAll(repo, 'the head');
  return { repo, base, head };
}

/** The project at the root of the repository in the base, moved under apps/demo in the head, each manifest saying where. */
function movedProject(t) {
  const repo = makeRepo(t);
  writeFiles(repo, { Dockerfile: DOCKERFILE, 'app.js': 'console.log(1)\n' });
  writeManifest(repo, [demoImage({ context: '.', dockerfile: 'Dockerfile' })]);
  const base = commitAll(repo, 'the project at the root');
  rmSync(join(repo, 'Dockerfile'));
  rmSync(join(repo, 'app.js'));
  writeFiles(repo, { 'apps/demo/Dockerfile': DOCKERFILE, 'apps/demo/app.js': 'console.log(1)\n' });
  writeManifest(repo, [demoImage()]);
  const head = commitAll(repo, 'the project in apps/demo');
  return { repo, base, head };
}

/** Runs images.mjs on a project's base and head, as the workflow does. */
function compare({ repo, base, head }, docker, extra = [], { env = docker.env, timeoutMs } = {}) {
  return runScript(IMAGES, ['--manifest', MANIFEST, '--base', base, '--head', head, ...extra], { cwd: repo, env, timeoutMs });
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
  images.forEach(({ name, baseFiles = FILES, headFiles = FILES }, index) => {
    for (const [side, files] of [['base', baseFiles], ['head', headFiles]]) {
      const tag = `move-check-images/${name}:${side}`;
      const id = `sha256:${String(index)}${side === 'base' ? 'a' : 'b'}`.padEnd(71, '0');
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

describe('images.mjs builds each image from a base and a head commit and compares them', () => {
  it('builds each side from an export of its own commit, without the build cache, and says they match', (t) => {
    const project = projectRepo(t);
    const docker = dockerFor(t, [{ name: 'demo' }]);

    const result = compare(project, docker, ['--keep']);

    assert.equal(result.status, 0, result.stderr);
    const kept = keptExports(t, result.stdout);
    const [baseBuild, headBuild] = builds(docker);
    assert.deepEqual(baseBuild.args, [
      'build', '--no-cache', '--file', join(kept, project.base, 'apps/demo/Dockerfile'), '--tag', 'move-check-images/demo:base', join(kept, project.base, 'apps/demo'),
    ]);
    assert.deepEqual(headBuild.args, [
      'build', '--no-cache', '--file', join(kept, project.head, 'apps/demo/Dockerfile'), '--tag', 'move-check-images/demo:head', join(kept, project.head, 'apps/demo'),
    ]);
    assert.equal(existsSync(join(kept, project.base, 'README.md')), false, 'the base export is its own commit');
    assert.equal(existsSync(join(kept, project.head, 'README.md')), true);
    assert.match(result.stdout, /^demo: image: match/m);
    assert.match(result.stdout, /^images: 1 compared, 1 match$/m);
  });

  it("builds each side as its own commit's manifest says, so a change to how an image builds still compares with its base", (t) => {
    const project = movedProject(t);
    const docker = dockerFor(t, [{ name: 'demo' }]);

    const result = compare(project, docker, ['--keep']);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const kept = keptExports(t, result.stdout);
    const [baseBuild, headBuild] = builds(docker);
    assert.deepEqual(baseBuild.args, ['build', '--no-cache', '--file', join(kept, project.base, 'Dockerfile'), '--tag', 'move-check-images/demo:base', join(kept, project.base)]);
    assert.deepEqual(headBuild.args, [
      'build', '--no-cache', '--file', join(kept, project.head, 'apps/demo/Dockerfile'), '--tag', 'move-check-images/demo:head', join(kept, project.head, 'apps/demo'),
    ]);
  });

  it("builds a base that has no manifest as the head's manifest says, and says so", (t) => {
    const project = projectRepo(t, { baseImages: null, headImages: [demoImage()] });
    const docker = dockerFor(t, [{ name: 'demo' }]);

    const result = compare(project, docker);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`^images: the base ${project.base.slice(0, 12)} has no images\\.json, so it is built as the head's manifest says$`, 'm'));
    assert.equal(builds(docker).length, 2);
    assert.match(result.stdout, /^images: 1 compared, 1 match$/m);
  });

  it("takes what may differ from the head's manifest alone", (t) => {
    const headFiles = { ...FILES, 'app/app.js': { content: 'console.log(2)\n' } };

    const baseAllows = projectRepo(t, { baseImages: [demoImage({ allow: ['/app/app.js'] })], headImages: [demoImage({ allow: [] })] });
    const refused = compare(baseAllows, dockerFor(t, [{ name: 'demo', headFiles }]));
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stdout, /^demo: image: differs/m);

    const headAllows = projectRepo(t, { baseImages: [demoImage({ allow: [] })], headImages: [demoImage({ allow: ['/app/app.js'] })] });
    const allowed = compare(headAllows, dockerFor(t, [{ name: 'demo', headFiles }]));
    assert.equal(allowed.status, 0, allowed.stdout);
    assert.match(allowed.stdout, /^demo: image: match, .*1 allowed difference$/m);
  });

  it('reports an image only one side names without building it, and still passes', (t) => {
    const project = projectRepo(t, {
      baseImages: [demoImage(), demoImage({ name: 'gone' })],
      headImages: [demoImage(), demoImage({ name: 'extra' })],
    });
    const docker = dockerFor(t, [{ name: 'demo' }]);

    const result = compare(project, docker);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(builds(docker).map((call) => call.args[5]), ['move-check-images/demo:base', 'move-check-images/demo:head']);
    assert.match(result.stdout, /^extra: only in the head's manifest, so there is nothing to compare it with$/m);
    assert.match(result.stdout, /^gone: only in the base's manifest, so it is not built$/m);
    assert.match(result.stdout, /^images: 1 compared, 1 match, 1 only in the head, 1 only in the base$/m);
  });

  it('removes each pair of images and the build cache once the pair is compared, when asked, and never otherwise', (t) => {
    const project = projectRepo(t, { baseImages: [demoImage(), demoImage({ name: 'other' })] });
    const docker = dockerFor(t, [{ name: 'demo' }, { name: 'other' }]);

    const kept = compare(project, docker);
    assert.equal(kept.status, 0, kept.stderr);
    assert.equal(docker.calls().some((call) => call.args[0] === 'image' && call.args[1] === 'rm'), false, 'the images stay for a person to inspect');
    const firstRunCalls = docker.calls().length;

    const removed = compare(project, docker, ['--remove-images']);
    assert.equal(removed.status, 0, removed.stderr);
    const cleanups = docker.calls().filter((call) => (call.args[0] === 'image' && call.args[1] === 'rm') || call.args[0] === 'builder');
    assert.deepEqual(cleanups.map((call) => call.args), [
      ['image', 'rm', '--force', 'move-check-images/demo:base', 'move-check-images/demo:head'],
      ['builder', 'prune', '--force'],
      ['image', 'rm', '--force', 'move-check-images/other:base', 'move-check-images/other:head'],
      ['builder', 'prune', '--force'],
    ]);
    const calls = docker.calls().slice(firstRunCalls).map((call) => call.args.join(' '));
    assert.ok(
      calls.indexOf('image rm --force move-check-images/demo:base move-check-images/demo:head') < calls.indexOf(calls.find((call) => call.includes('move-check-images/other:base') && call.startsWith('build'))),
      'a pair is removed before the next pair is built',
    );
  });

  it('lets a difference the manifest allows through', (t) => {
    const project = projectRepo(t);
    const docker = dockerFor(t, [{ name: 'demo', headFiles: { ...FILES, 'app/build-stamp.txt': { content: 'built at 2\n' } } }]);

    const result = compare(project, docker);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^demo: image: match, .*1 allowed difference$/m);
  });

  it("shows pnpm's own files under their image, and counts an image that matches apart from them on its own", (t) => {
    const project = projectRepo(t, { baseImages: [demoImage(), demoImage({ name: 'other' })] });
    const headFiles = { ...FILES, 'app/node_modules/.modules.yaml': { content: '{\n  "packageManager": "pnpm@11.10.0"\n}\n' } };
    const docker = dockerFor(t, [{ name: 'demo', headFiles }, { name: 'other' }]);

    const result = compare(project, docker);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^demo: image: match apart from pnpm's own files, .*1 of pnpm's own files differs$/m);
    assert.match(result.stdout, /^ {4}\/app\/node_modules\/\.modules\.yaml {2}written by no named pnpm -> pnpm@11\.10\.0, as YAML -> JSON$/m);
    assert.match(result.stdout, /^other: image: match, [^\n]*\nimages:/m, 'an image that matches outright takes one line');
    assert.match(result.stdout, /^images: 2 compared, 1 match, 1 match apart from pnpm's own files$/m);
  });

  it("hands the head's map to image.mjs, which compares a folder kept under another name entry by entry", (t) => {
    const project = projectRepo(t, { headImages: [demoImage({ map: ['/app/old=/app/new'] })] });
    const baseFiles = { ...FILES, 'app/old/x.js': { content: 'x\n' } };
    const headFiles = { ...FILES, 'app/new/x.js': { content: 'x\n' } };
    const docker = dockerFor(t, [{ name: 'demo', baseFiles, headFiles }]);

    const result = compare(project, docker);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^demo: image: match, 9 config fields equal, 4 identical filesystem entries, 1 entry renamed by --map$/m);
  });

  it('reports a difference too long for a default output buffer as a difference, with its whole listing', (t) => {
    const project = projectRepo(t);
    const headFiles = { ...FILES };
    for (let index = 0; index < LARGE_DIFFERENCE_FILES; index += 1) {
      headFiles[`app/generated/a-file-with-a-long-enough-name-${String(index).padStart(5, '0')}.js`] = { content: 'x\n' };
    }
    const docker = dockerFor(t, [{ name: 'demo', headFiles }]);

    const result = compare(project, docker);

    assert.equal(result.status, 1, `${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`);
    assert.doesNotMatch(result.stdout, /could not be checked/);
    assert.match(result.stdout, /a-file-with-a-long-enough-name-19999\.js/, 'the last difference is in the listing');
  });

  it('runs the prepare commands in the context of each side before building it, as a deploy script builds first', (t) => {
    const prepare = [[process.execPath, '-e', "require('node:fs').writeFileSync('prepared.txt', 'built\\n'); console.log('prepared')"]];
    const project = projectRepo(t, { baseImages: [demoImage({ prepare })] });
    const docker = dockerFor(t, [{ name: 'demo' }]);

    const result = compare(project, docker, ['--keep']);
    keptExports(t, result.stdout);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(builds(docker).length, 2);
    for (const build of builds(docker)) assert.equal(existsSync(join(build.args.at(-1), 'prepared.txt')), true, build.args.at(-1));
    assert.equal(result.stderr.match(/^prepared$/gm)?.length, 2, 'what each prepare command printed reached stderr');
  });

  it("prepares each side as its own manifest says, so a head can add a step its base did not have", (t) => {
    const prepare = [[process.execPath, '-e', "require('node:fs').writeFileSync('prepared.txt', 'built\\n')"]];
    const project = projectRepo(t, { baseImages: [demoImage()], headImages: [demoImage({ prepare })] });
    const docker = dockerFor(t, [{ name: 'demo' }]);

    const result = compare(project, docker, ['--keep']);
    keptExports(t, result.stdout);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const [baseBuild, headBuild] = builds(docker);
    assert.equal(existsSync(join(baseBuild.args.at(-1), 'prepared.txt')), false, 'the base has no prepare step');
    assert.equal(existsSync(join(headBuild.args.at(-1), 'prepared.txt')), true, 'the head has one');
  });

  it('stops with 2 when a prepare command fails, naming the side, and builds nothing of that pair', (t) => {
    const project = projectRepo(t, {
      baseImages: [demoImage({ prepare: [[process.execPath, '-e', 'process.exit(3)']] })],
      headImages: [demoImage()],
    });
    const docker = dockerFor(t, [{ name: 'demo' }]);

    const result = compare(project, docker);

    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^demo: could not be checked: the base prepare failed/m);
    assert.equal(builds(docker).length, 0);
  });

  it('prints each pair as it is compared, so a run cut off later keeps the verdicts it reached', (t) => {
    const project = projectRepo(t, { baseImages: [demoImage(), demoImage({ name: 'other' })] });
    const docker = dockerFor(t, [{ name: 'demo' }, { name: 'other' }], {
      first: [{ argsInclude: ['build', 'move-check-images/other:base'], stdout: '', sleepMs: SLOW_BUILD_MS }],
    });
    // A run cut off never reaches its own clean-up, so its exports go to a folder the test removes.
    const scratch = makeTempDir(t, 'move-check-cut-off-');

    const result = compare(project, docker, [], { env: { ...docker.env, TMPDIR: scratch }, timeoutMs: CUT_OFF_MS });

    assert.equal(result.signal, 'SIGTERM', 'the run was cut off during the second pair');
    assert.match(result.stdout, /^demo: .*match/m, 'the first pair was already reported');
    assert.ok(readdirSync(scratch).some((name) => name.startsWith('move-check-images-')), 'the cut-off run left its exports where the test removes them');
  });

  it("passes each build's output to stderr as it comes, so a build that stalls shows where it stopped", (t) => {
    const project = projectRepo(t);
    const docker = dockerFor(t, [{ name: 'demo' }], {
      first: [{ argsInclude: ['build', 'move-check-images/demo:base'], progress: '#5 [2/5] RUN apt-get update\n', sleepMs: SLOW_BUILD_MS }],
    });
    const scratch = makeTempDir(t, 'move-check-stall-');

    const result = compare(project, docker, [], { env: { ...docker.env, TMPDIR: scratch }, timeoutMs: CUT_OFF_MS });

    assert.equal(result.signal, 'SIGTERM', 'the run was cut off while the build stalled');
    assert.match(result.stderr, /^#5 \[2\/5\] RUN apt-get update$/m, 'the step the build stalled in was already on stderr');
  });

  it('reports an image that differs with what image.mjs found, and exits 1', (t) => {
    const project = projectRepo(t);
    const docker = dockerFor(t, [{ name: 'demo', headFiles: { ...FILES, 'app/app.js': { content: 'console.log(2)\n' } } }]);

    const result = compare(project, docker);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^demo: image: differs/m);
    assert.match(result.stdout, /^ {4}\/app\/app\.js {2}sha256/m, 'the changed file is named, under its image');
    assert.match(result.stdout, /^images: 1 compared, 0 match, 1 differs$/m);
  });

  it('stops with 2 when a build fails, naming the image and the side, and still checks the rest', (t) => {
    const project = projectRepo(t, { baseImages: [demoImage(), demoImage({ name: 'other' })] });
    const docker = dockerFor(t, [{ name: 'demo' }, { name: 'other' }], {
      first: [{ argsInclude: ['build', 'move-check-images/demo:head'], status: 1, stderr: 'ERROR: failed to solve: a step failed\n' }],
    });

    const result = compare(project, docker);

    assert.equal(result.status, 2);
    assert.match(result.stdout, /^demo: could not be checked: the head build failed/m);
    assert.match(result.stdout, /failed to solve: a step failed/);
    assert.match(result.stdout, /^other: image: match/m);
    assert.match(result.stdout, /^images: 2 compared, 1 match, 1 could not be checked$/m);
  });
});

describe('images.mjs reads its arguments and both manifests strictly', () => {
  it('plans every build without building anything, having found every commit, context and Dockerfile', (t) => {
    const project = movedProject(t);
    const docker = dockerFor(t, []);

    const result = compare(project, docker, ['--plan']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(builds(docker).length, 0);
    assert.match(result.stdout, new RegExp(`base ${project.base}: docker build --no-cache --file Dockerfile --tag move-check-images/demo:base \\.$`, 'm'));
    assert.match(result.stdout, new RegExp(`head ${project.head}: docker build --no-cache --file apps/demo/Dockerfile --tag move-check-images/demo:head apps/demo$`, 'm'));
    assert.match(result.stdout, /^images: plan, 1 image, 2 builds, every commit, context and Dockerfile found$/m);
  });

  it('refuses a plan whose Dockerfile or context is not in its commit, naming the side', (t) => {
    const project = projectRepo(t, { headImages: [demoImage({ dockerfile: 'apps/demo/Dockerfile.missing' })] });
    const docker = dockerFor(t, []);

    const result = compare(project, docker, ['--plan']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`demo head: ${project.head} has no apps/demo/Dockerfile\\.missing`));
  });

  it("refuses an entry of the head's manifest that could leave the repository or is malformed, before building", (t) => {
    const broken = [
      demoImage({ context: '../outside' }),
      demoImage({ dockerfile: '/etc/Dockerfile' }),
      demoImage({ name: 'Demo Image' }),
      demoImage({ allow: '/app/build-stamp.txt' }),
      demoImage({ prepare: 'pnpm build' }),
    ];
    for (const entry of broken) {
      const project = projectRepo(t, { baseImages: [demoImage()], headImages: [entry] });
      const docker = dockerFor(t, []);
      const result = compare(project, docker);
      assert.equal(result.status, 2, JSON.stringify(entry));
      assert.match(result.stderr, /^images\.json at [0-9a-f]{12}: /m, JSON.stringify(entry));
      assert.equal(builds(docker).length, 0);
    }
  });

  it("refuses a base whose manifest cannot be read, naming the base's copy", (t) => {
    const repo = makeRepo(t);
    writeFiles(repo, { 'apps/demo/Dockerfile': DOCKERFILE, 'apps/demo/app.js': 'console.log(1)\n', [MANIFEST]: '{ "images": [' });
    const base = commitAll(repo, 'a broken manifest');
    writeManifest(repo, [demoImage()]);
    const head = commitAll(repo, 'the manifest mended');
    const docker = dockerFor(t, []);

    const result = compare({ repo, base, head }, docker);

    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`^images\\.json at ${base.slice(0, 12)} could not be read as JSON`, 'm'));
  });

  it('refuses a map that is not a list of <old>=<new> renames, naming the image, before building', (t) => {
    const broken = [demoImage({ map: '/app/old=/app/new' }), demoImage({ map: ['/app/old'] }), demoImage({ map: ['/app/old=/app/new', '/app/old=/app/other'] })];
    for (const entry of broken) {
      const project = projectRepo(t, { baseImages: [demoImage()], headImages: [entry] });
      const docker = dockerFor(t, []);
      const result = compare(project, docker);
      assert.equal(result.status, 2, JSON.stringify(entry));
      assert.match(result.stderr, /: demo: map /m, JSON.stringify(entry));
      assert.equal(builds(docker).length, 0);
    }
  });

  it('refuses two images of one name', (t) => {
    const project = projectRepo(t, { baseImages: [demoImage()], headImages: [demoImage(), demoImage()] });
    const docker = dockerFor(t, []);

    const result = compare(project, docker);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /demo is named twice/);
  });

  it("runs only the images --only names, and refuses a name the head's manifest does not have", (t) => {
    const project = projectRepo(t, { baseImages: [demoImage(), demoImage({ name: 'other' })] });
    const docker = dockerFor(t, [{ name: 'other' }]);

    const only = compare(project, docker, ['--only', 'other']);
    assert.equal(only.status, 0, only.stderr);
    assert.deepEqual(builds(docker).map((call) => call.args[5]), ['move-check-images/other:base', 'move-check-images/other:head']);

    const unknown = compare(project, docker, ['--only', 'missing']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /--only missing names no image in the head's manifest/);
  });

  it('needs --manifest, --base and --head, each a commit or path it can find', (t) => {
    const project = projectRepo(t);
    const docker = dockerFor(t, []);
    const run = (args) => runScript(IMAGES, args, { cwd: project.repo, env: docker.env });

    const noBase = run(['--manifest', MANIFEST, '--head', project.head]);
    assert.equal(noBase.status, 2);
    assert.match(noBase.stderr, /--base is required/);

    const unknown = run(['--manifest', MANIFEST, '--base', project.base, '--head', 'no-such-branch']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /--head no-such-branch is not a commit in this repository/);

    const option = run(['--manifest', MANIFEST, '--base', '--output=x', '--head', project.head]);
    assert.equal(option.status, 2);

    const outside = run(['--manifest', '../images.json', '--base', project.base, '--head', project.head]);
    assert.equal(outside.status, 2);
    assert.match(outside.stderr, /--manifest is a path of plain names/);
  });

  it('refuses a head without the manifest', (t) => {
    const project = projectRepo(t, { baseImages: [demoImage()], headImages: null });
    const docker = dockerFor(t, []);

    const result = compare(project, docker);

    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`the head ${project.head.slice(0, 12)} has no images\\.json`));
  });
});
