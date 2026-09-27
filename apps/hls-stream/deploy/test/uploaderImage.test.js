import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALL_REMOTE, makeSandbox, removeSandboxes, runScriptOk } from './helpers/sandbox.js';

after(removeSandboxes);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** The repository the stack is one app of, whose `packages/` holds the packages every app shares. */
const REPOSITORY_ROOT = resolve(ROOT, '../..');

const dockerfile = readFileSync(resolve(ROOT, 'deploy/Dockerfile.uploader'), 'utf8');
const clientDockerfile = readFileSync(resolve(ROOT, 'deploy/Dockerfile.client'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'packages/stream-uploader/package.json'), 'utf8'));
const rootManifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

/** Where `deploy.sh` puts a deployment on a remote host, as `_lib.sh` hardcodes it. */
const REMOTE_BASE = 'swarm-hls-stream';

/**
 * Every path the image COPYs out of the build context, which is the monorepo root.
 *
 * A `--from=` copy is between stages and comes from an earlier layer rather than from the context,
 * so it is not something a deploy has to ship. The last word of a COPY is the destination.
 */
function contextPaths(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('COPY ') && !line.includes('--from='))
    .flatMap((line) => line.split(/\s+/).slice(1, -1));
}

/**
 * The production uploader image against the tree it installs from.
 *
 * Nothing else checks this pair. CI never builds an image, and the uploader's own tests run under
 * tsx against the workspace symlink rather than against the compiled copy that ships, so the first
 * report of a break here is a failed deploy.
 */
describe('uploader image install (ARCH-1)', () => {
  /**
   * ⛔ The whole point of the pnpm rewrite of 2026-09-05. The image used to install with
   * `npm install --omit=dev` from the uploader manifest alone, with no lockfile in the context, so
   * every transitive range was re-resolved at build time and the reviewed tree never reached
   * production. Measured that day: the root manifest's `pnpm.overrides` pinned axios to ^0.33.0
   * after a provenance check, `pnpm why axios` reported 0.33.0, and the built image ran 0.30.3.
   *
   * `--frozen-lockfile` is what refuses instead of re-resolving. `pnpm deploy` did NOT honour it
   * on pnpm 9.12.0, measured against a manifest whose zod range had been moved off the lockfile's:
   * the deploy re-resolved to the drifted version and exited 0, while `pnpm install` with the same
   * flag exited ERR_PNPM_OUTDATED_LOCKFILE. So the install is the gate and a deploy alone is not.
   */
  it('installs from the workspace lockfile instead of re-resolving every build', () => {
    const install = dockerfile.match(/^RUN .*pnpm install.*$/m);

    assert.ok(install, 'the image no longer installs with pnpm, so this test is checking the wrong thing');
    assert.match(
      install[0],
      /--frozen-lockfile/,
      'without --frozen-lockfile the install resolves its own versions and the audited tree never ships',
    );
  });

  it('copies the lockfile, the root manifest and the workspace file that carries the overrides', () => {
    const copied = contextPaths(dockerfile);

    for (const path of ['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml']) {
      assert.ok(copied.includes(path), `${path} is not in the build context, so the install cannot read it`);
    }
  });

  /**
   * One pnpm, named in one place. Corepack activates whatever this line says, so a Dockerfile
   * pinning a different version from the root manifest installs with a resolver the workspace was
   * never checked against. The pin carries the checksum of the pnpm package, which corepack checks
   * the download against.
   */
  it('activates the pnpm version the root manifest names', () => {
    const pinned = rootManifest.packageManager;

    assert.match(
      pinned,
      /^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/,
      `the root manifest no longer pins pnpm by version and checksum: ${pinned}`,
    );
    assert.ok(
      dockerfile.includes(`corepack prepare ${pinned} --activate`),
      `the image must activate ${pinned}, the version the root manifest names`,
    );
  });

  /**
   * ⛔ pnpm resolves a `workspace:` link against the packages it can see BEFORE a filter narrows
   * anything and before `--prod` drops a dev block, so a workspace dependency whose manifest is
   * missing from the context kills the build with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND. Measured
   * 2026-09-05 by building without `packages/shared/package.json`.
   *
   * The links of those packages count too, because pnpm resolves them the same way: shared links the
   * repository's contracts package, which the context holds where a cut puts it.
   *
   * Derived from the manifests and from the packages on disk rather than hardcoded, so a second
   * workspace dependency has to be copied in too.
   */
  it('copies the manifest of every workspace package the uploader declares, and of every one they link', () => {
    const copied = contextPaths(dockerfile);

    for (const name of withWorkspaceDependencies(workspaceLinks(manifest))) {
      const { contextManifest } = workspacePackage(name);
      assert.ok(
        copied.includes(contextManifest),
        `${name} is a workspace dependency of the uploader and ${contextManifest} is not copied, so the install refuses`,
      );
    }
  });

  /**
   * A workspace dependency in the production block would have to be installed rather than skipped,
   * and the image carries no sources for it: only the manifests are in the build context. The copy
   * that ships is the one `vendor-shared.mjs` compiled into `dist/node_modules`.
   */
  it('keeps every workspace dependency out of the production dependencies block', () => {
    const production = Object.entries(manifest.dependencies ?? {}).filter(([, range]) =>
      String(range).startsWith('workspace:'),
    );

    assert.deepEqual(
      production.map(([name]) => name),
      [],
      'a workspace dependency in `dependencies` is one the image would have to install and cannot',
    );
  });

  // The vendored copy is what makes the devDependency safe to skip. If the build stopped producing
  // it, the image would install cleanly and then fail at require time instead.
  it('vendors the shared package into dist as part of the build', () => {
    assert.match(
      manifest.scripts.build,
      /vendor-shared\.mjs/,
      'the build no longer vendors shared, so nothing supplies it at runtime',
    );
  });
});

/**
 * The workspace package named `name`: its folder, its manifest, and where an image's build context
 * holds that manifest.
 *
 * The stack's own packages sit under its `packages/`. A package every app shares sits under the
 * repository's `packages/` in a checkout and under `workspace-packages/` in a cut, and a build context
 * is always a cut, so both of those are `workspace-packages/<folder>` there.
 */
function workspacePackage(name) {
  const places = [
    { folder: resolve(ROOT, 'packages'), inContext: 'packages' },
    { folder: resolve(ROOT, 'workspace-packages'), inContext: 'workspace-packages' },
    { folder: resolve(REPOSITORY_ROOT, 'packages'), inContext: 'workspace-packages' },
  ];
  for (const { folder, inContext } of places) {
    if (!existsSync(folder)) {
      continue;
    }
    for (const entry of readdirSync(folder)) {
      const path = resolve(folder, entry, 'package.json');
      if (!existsSync(path)) {
        continue;
      }
      const packageManifest = JSON.parse(readFileSync(path, 'utf8'));
      if (packageManifest.name === name) {
        return {
          dir: resolve(folder, entry),
          manifest: packageManifest,
          contextManifest: `${inContext}/${entry}/package.json`,
        };
      }
    }
  }
  throw new Error(`no workspace package is named ${name}`);
}

/** The names a manifest links with a `workspace:` range, in the blocks given. */
function workspaceLinks(packageManifest, blocks = ['dependencies', 'devDependencies']) {
  return blocks
    .flatMap((block) => Object.entries(packageManifest[block] ?? {}))
    .filter(([, range]) => String(range).startsWith('workspace:'))
    .map(([name]) => name);
}

/** The packages named and every workspace package their `dependencies` reach, each once, in the order met. */
function withWorkspaceDependencies(names) {
  const reached = [];
  const pending = [...names];
  while (pending.length > 0) {
    const name = pending.shift();
    if (!reached.includes(name)) {
      reached.push(name);
      pending.push(...workspaceLinks(workspacePackage(name).manifest, ['dependencies']));
    }
  }
  return reached;
}

/**
 * That a remote deploy leaves the far side holding everything the image COPYs.
 *
 * The uploader image is built ON the deployment host out of whatever `sync_to_remote` put there. A
 * path the Dockerfile needs and the sync does not carry fails as `failed to compute cache key:
 * "/pnpm-lock.yaml": not found`, on a machine nobody is watching, and it reads as a build error
 * rather than as a missing file. This is the failure the client block already carries a comment
 * about, and until 2026-09-05 the uploader block shipped only `dist/` and its own manifest.
 *
 * Read off the Dockerfile rather than from a list written here, so a COPY added there without a
 * matching rsync fails instead of shipping.
 *
 * ⛔ Observed as the files that landed on the sandbox's stand-in remote host, because the rsync stub
 * copies for real. A sandbox is an `mkdtemp` and not a checkout, so the workspace files are seeded
 * into it first: without them the sync has nothing to send and the assertions would be reporting on
 * the seeding rather than on the script.
 */
describe('what a remote deploy leaves in the uploader build context', () => {
  /**
   * What a stack's tree holds that a deploy sends for either image, seeded on top of the two
   * Dockerfiles' own lists so a test is asserting the script rather than the seeding. The tree keeps
   * its own lockfile, as every build tree the manager makes does, with the shared packages it links
   * in `workspace-packages`, where a cut puts them.
   */
  const WORKSPACE_FILES = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'packages/shared/package.json',
    'workspace-packages/contracts/package.json',
  ];

  /**
   * A COPY source is a folder when it ends in `/` or its last name has no extension, as
   * `packages/client` and `workspace-packages/contracts` do. A folder is seeded with one file in it.
   */
  function seedContext(sandbox) {
    for (const path of new Set([...WORKSPACE_FILES, ...contextPaths(dockerfile), ...contextPaths(clientDockerfile)])) {
      const target = join(sandbox.root, path);
      const isFolder = path.endsWith('/') || !basename(path).includes('.');
      mkdirSync(isFolder ? target : dirname(target), { recursive: true });
      const contents = path.endsWith('.json') ? `{"seeded": "${path}"}\n` : `${path}\n`;
      writeFileSync(isFolder ? join(target, 'seeded') : target, contents);
    }
  }

  async function deployRemotely(...services) {
    const sandbox = makeSandbox({ config: ALL_REMOTE, project: 'default' });
    seedContext(sandbox);
    await runScriptOk(sandbox, 'deploy.sh', services);
    return sandbox;
  }

  function assertContextArrived(sandbox, image, text) {
    for (const path of contextPaths(text)) {
      assert.ok(
        sandbox.remoteHas(join(REMOTE_BASE, path)),
        `${image} copies ${path} and no rsync carries it to the deployment host`,
      );
    }
  }

  it('ships every path the uploader image copies', async () => {
    assertContextArrived(await deployRemotely('stream-uploader'), 'Dockerfile.uploader', dockerfile);
  });

  /**
   * The root manifests are the client's too, so they are sent once for either service rather than
   * from inside both blocks. A hoist like that is exactly the kind that survives its own test by
   * being reachable from one branch only.
   */
  it('ships them when the client deploys alongside', async () => {
    const sandbox = await deployRemotely('stream-uploader', 'client');

    assertContextArrived(sandbox, 'Dockerfile.uploader', dockerfile);
    assertContextArrived(sandbox, 'Dockerfile.client', clientDockerfile);
  });

  it('ships every path the client image copies on a client-only deploy', async () => {
    assertContextArrived(await deployRemotely('client'), 'Dockerfile.client', clientDockerfile);
  });

  it('ships the shared packages of a tree that keeps its own lockfile, for either image', async () => {
    for (const services of [['stream-uploader'], ['client']]) {
      const sandbox = await deployRemotely(...services);

      assert.ok(
        sandbox.remoteHas(join(REMOTE_BASE, 'workspace-packages/contracts/package.json')),
        `a deploy of ${services.join(' and ')} left workspace-packages/contracts behind`,
      );
    }
  });
});

/**
 * That every entry point the shared package advertises survives being vendored into the image.
 *
 * This is the check that was missing on 2026-08-03, and its absence cost a crash-looping deployment.
 * `@swarm-hls-stream/shared` gained a `./publishKey` subpath, `vendor-shared.mjs` wrote a manifest
 * with a hand-listed `.` entry and nothing else, and the uploader died at its first import with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. Every check in the repository was green while it did, because
 * nothing outside the image resolves the vendored copy: `pnpm verify`, `tsx` and `tsc` all follow
 * the workspace symlink to the source package, whose `exports` was correct the whole time.
 *
 * So this reads both manifests and compares them, which is the one question the suite could not
 * otherwise ask. It deliberately does not re-derive the compiled paths with the same expression the
 * script uses, because a test that repeats the implementation agrees with it however wrong it is.
 *
 * Asked of every package vendored, which is shared and every workspace package it links, such as the
 * repository's contracts package: the vendored shared imports those by name, and they resolve only
 * because they were vendored beside it.
 */
for (const name of withWorkspaceDependencies(workspaceLinks(manifest))) {
  describe(`the vendored ${name} manifest keeps every advertised entry point`, () => {
    const sourceManifest = workspacePackage(name).manifest;
    const vendoredPath = resolve(ROOT, 'packages/stream-uploader/dist/node_modules', name, 'package.json');

    /**
     * Says which precondition is missing rather than surfacing a bare ENOENT.
     *
     * These two read a build artifact, and for a while CI ran `pnpm test` before `pnpm build`. The
     * result was two failures on every clean checkout and none on any machine that had built once,
     * reported as an unreadable path error. The ordering is fixed in both `verify` and the workflow,
     * so this should now be unreachable, and it is here to name the cause if it ever is not.
     */
    function readVendored() {
      if (!existsSync(vendoredPath)) {
        throw new Error(
          `${vendoredPath} does not exist, so the uploader has not been built in this tree. ` +
            'Run `pnpm build` first. These tests assert a property of the build output and cannot ' +
            'run without it.',
        );
      }
      return JSON.parse(readFileSync(vendoredPath, 'utf8'));
    }

    it('exports the same subpaths the source package does', () => {
      const vendored = readVendored();

      assert.deepEqual(
        Object.keys(vendored.exports).sort(),
        Object.keys(sourceManifest.exports).sort(),
        'a subpath the source advertises is missing from the image, so it throws ERR_PACKAGE_PATH_NOT_EXPORTED at runtime',
      );
    });

    /**
     * The other half of the same failure. A subpath present but pointing at a file the compiler never
     * emitted fails identically from the outside, and `.ts` surviving into the manifest is the exact
     * shape that would do it, since the source really does point its `exports` at TypeScript.
     */
    /**
     * What the vendored copy needs at runtime, which is a different question from what it exports.
     *
     * `packages/shared` gained its first runtime dependencies in this branch, `@ethersphere/bee-js` and
     * `cafe-utility`, and its first module importing them, which `index.js` re-exports eagerly. The
     * image installs from the **uploader's** manifest: nothing ever runs an install inside
     * `dist/node_modules`, so a package shared imports but the uploader does not declare reaches the
     * image only if something else happens to put it where Node will look.
     *
     * `cafe-utility` was exactly that. Under the npm install this image used to run it resolved by
     * accident, because `@ethersphere/bee-js` declares a compatible range of it and npm hoists flat.
     * pnpm does not: the top level of the installed tree holds the uploader's own dependencies and
     * nothing else, so an undeclared package now fails outright rather than working until a bee-js
     * release moves off it.
     *
     * A workspace package is the exception, because it is vendored beside this one rather than
     * installed, and its own block is asked the same question.
     */
    it('declares in the uploader manifest every package the vendored copy imports', () => {
      for (const [dependency, range] of Object.entries(sourceManifest.dependencies ?? {})) {
        if (String(range).startsWith('workspace:')) {
          continue;
        }
        assert.equal(
          manifest.dependencies?.[dependency],
          range,
          `${name} needs ${dependency}@${range} at runtime and the image installs only from the uploader's ` +
            'manifest, so it has to be declared there too, at the same version the workspace resolved',
        );
      }
    });

    it('carries the source package dependencies into the vendored manifest', () => {
      assert.deepEqual(
        readVendored().dependencies ?? {},
        sourceManifest.dependencies ?? {},
        'the vendored copy has to state what it needs, or nothing in the image records the requirement',
      );
    });

    it('points every export at a file that exists next to it', () => {
      const vendored = readVendored();
      const vendorDir = dirname(vendoredPath);

      for (const [subpath, entry] of Object.entries(vendored.exports)) {
        // Spelled as what each condition must be rather than as what it must not be. The first version
        // of this banned a trailing `.ts` and failed on `./index.d.ts`, which is the correct value for
        // `types`: a declaration file ends in `.ts` too.
        assert.match(entry.default, /\.js$/, `${subpath} must load JavaScript, not ${entry.default}`);
        assert.match(entry.types, /\.d\.ts$/, `${subpath} must be typed by a declaration, not ${entry.types}`);
        assert.deepEqual(
          Object.keys(entry).sort(),
          Object.keys(sourceManifest.exports[subpath]).sort(),
          `${subpath} lost a condition the source advertises, so an import asking for it falls through`,
        );

        for (const [condition, target] of Object.entries(entry)) {
          if (condition !== 'types') {
            assert.match(target, /\.js$/, `${subpath} must load JavaScript under ${condition}, not ${target}`);
          }
          assert.ok(existsSync(resolve(vendorDir, target)), `${subpath} points at ${target}, which was not emitted`);
        }
      }
    });
  });
}
