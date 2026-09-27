import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { TEST_ENV, TOOL_DIR, commitAll, makeTempDir, runScript, writeFiles } from './support/fixtures.mjs';
import { expectedCut, manifest, manifestOf, realAppFiles } from './support/workspace.mjs';

const IN_COPY = 'in-copy.mjs';

/**
 * A command for in-copy.mjs to run: it writes where it ran and every file and link it found there to the file its
 * first argument names, then exits with the status its second argument gives.
 */
const LIST_FILES = `
const { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } = require('node:fs');
const { join, relative } = require('node:path');
const files = {};
const links = {};
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const entry = lstatSync(full);
    if (entry.isSymbolicLink()) links[relative(process.cwd(), full)] = readlinkSync(full);
    else if (entry.isDirectory()) walk(full);
    else files[relative(process.cwd(), full)] = readFileSync(full, 'utf8');
  }
};
walk(process.cwd());
writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), files, links, named: process.env.APP_WORKSPACE_COPY }));
process.exit(Number(process.argv[2] ?? 0));
`;

/**
 * A checkout of the two-app workspace. After its one commit the admin gains a file git does not ignore and a change to
 * a committed one, and it holds two files git ignores, a local env file and an installed package.
 */
function makeCheckout(t, files = {}) {
  const root = makeTempDir(t);
  writeFiles(root, {
    ...realAppFiles(),
    '.gitignore': '.env\nnode_modules/\n',
    'apps/web2-admin/backend/src/index.ts': 'export {};\n',
    ...files,
  });
  symlinkSync('src/index.ts', join(root, 'apps/web2-admin/backend/entry.ts'));
  commitAll(root);
  writeFiles(root, {
    'apps/web2-admin/backend/src/added.ts': 'export const added = 1;\n',
    'apps/web2-admin/backend/src/index.ts': 'export const changed = 1;\n',
    'apps/web2-admin/backend/.env': 'LOCAL_ONLY=1\n',
    'apps/web2-admin/node_modules/left-pad/index.js': 'module.exports = 1;\n',
  });
  return root;
}

function listIn(t, root, { status = 0, options = [] } = {}) {
  const listing = join(makeTempDir(t), 'listing.json');
  const result = runScript(IN_COPY, [
    '--root',
    root,
    '--app',
    'apps/web2-admin',
    ...options,
    '--',
    process.execPath,
    '-e',
    LIST_FILES,
    listing,
    String(status),
  ]);
  const seen = existsSync(listing) ? JSON.parse(readFileSync(listing, 'utf8')) : null;
  return { result, seen };
}

describe('in-copy.mjs', () => {
  it('runs the command in a copy of the app as git sees it on disk, with the cut pair beside it', (t) => {
    const { result, seen } = listIn(t, makeCheckout(t));

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(Object.keys(seen.files).sort(), [
      'backend/src/added.ts',
      'backend/src/index.ts',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ]);
    assert.equal(seen.files['backend/src/index.ts'], 'export const changed = 1;\n');
    assert.equal(seen.files['pnpm-lock.yaml'], expectedCut('apps/web2-admin', false).lockfile);
    assert.equal(seen.files['pnpm-workspace.yaml'], expectedCut('apps/web2-admin', false).workspace);
  });

  it('names the copy to the command in APP_WORKSPACE_COPY, so a compose file can point a build context at it', (t) => {
    const { seen } = listIn(t, makeCheckout(t));

    assert.equal(seen.named, seen.cwd);
  });

  it('copies a path git ignores when --also names it, such as a build output an image copies in', (t) => {
    const root = makeCheckout(t, { '.gitignore': '.env\nnode_modules/\ndist/\n' });
    writeFiles(root, { 'apps/web2-admin/backend/dist/index.js': 'built\n', 'apps/web2-admin/dist/other.js': 'not asked for\n' });

    const { result, seen } = listIn(t, root, { options: ['--also', 'backend/dist'] });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(seen.files['backend/dist/index.js'], 'built\n');
    assert.equal(seen.files['dist/other.js'], undefined, 'an ignored path --also does not name stays behind');
  });

  it('refuses an --also path that is not there, and runs nothing', (t) => {
    const { result, seen } = listIn(t, makeCheckout(t), { options: ['--also', 'backend/dist'] });

    assert.equal(result.status, 125);
    assert.match(result.stderr, /backend\/dist/);
    assert.equal(seen, null);
  });

  it('refuses an --also path that is or holds an env file, and runs nothing', (t) => {
    const root = makeCheckout(t, { '.gitignore': '.env\n.env.*\nnode_modules/\ndist/\n' });
    writeFiles(root, {
      'apps/web2-admin/backend/.env.local': 'LOCAL_ONLY=1\n',
      'apps/web2-admin/backend/dist/index.js': 'built\n',
      'apps/web2-admin/backend/dist/config/.env.production': 'LOCAL_ONLY=1\n',
    });

    for (const path of ['backend/.env', 'backend/.env.local', 'backend/dist']) {
      const { result, seen } = listIn(t, root, { options: ['--also', path] });

      assert.equal(result.status, 125, `${path}: ${result.stderr}`);
      assert.match(result.stderr, /env file/, path);
      assert.doesNotMatch(result.stderr, /LOCAL_ONLY/, `${path}: the refusal printed what the file holds`);
      assert.equal(seen, null, `${path}: the command ran`);
    }
  });

  it('refuses an --also path that leaves the app, and runs nothing', (t) => {
    for (const path of ['../infra-manager', '/etc']) {
      const { result, seen } = listIn(t, makeCheckout(t), { options: ['--also', path] });

      assert.equal(result.status, 125, path);
      assert.equal(seen, null, path);
    }
  });

  it('copies a link as a link', (t) => {
    const { seen } = listIn(t, makeCheckout(t));

    assert.deepEqual(seen.links, { 'backend/entry.ts': 'src/index.ts' });
  });

  it('makes the copy outside the checkout', (t) => {
    const root = makeCheckout(t);
    const { seen } = listIn(t, root);

    assert.equal(seen.cwd.startsWith(`${realpathSync(root)}${sep}`), false);
  });

  it("removes the copy after the command, and exits with the command's status", (t) => {
    const { result, seen } = listIn(t, makeCheckout(t), { status: 3 });

    assert.equal(result.status, 3);
    assert.equal(existsSync(seen.cwd), false);
  });

  it('removes the copy when it is stopped while the command runs, and exits as the stopped command did', async (t) => {
    const root = makeCheckout(t);
    const listing = join(makeTempDir(t), 'listing.json');
    const listThenWait = `${LIST_FILES.replace(/process\.exit\(.*\);\n$/, '')}setTimeout(() => {}, 60000);\n`;
    const child = spawn(
      process.execPath,
      [join(TOOL_DIR, IN_COPY), '--root', root, '--app', 'apps/web2-admin', '--', process.execPath, '-e', listThenWait, listing],
      { env: TEST_ENV, stdio: 'ignore' },
    );
    const exited = once(child, 'exit');
    for (let waited = 0; !existsSync(listing) && waited < 20000; waited += 50) await sleep(50);

    child.kill('SIGTERM');
    const [status] = await exited;

    const { cwd } = JSON.parse(readFileSync(listing, 'utf8'));
    assert.equal(existsSync(cwd), false);
    assert.equal(status, 143);
  });

  it('runs the command in a plain copy when the root holds no lockfile, since there the apps keep their own', (t) => {
    const root = makeTempDir(t);
    writeFiles(root, {
      'package.json': manifest('fixture-root'),
      'apps/web2-admin/package.json': manifest('beta'),
      'apps/web2-admin/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'apps/web2-admin/pnpm-workspace.yaml': 'packages:\n  - backend\n',
    });
    commitAll(root);

    const { result, seen } = listIn(t, root);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(Object.keys(seen.files).sort(), ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);
    assert.equal(seen.files['pnpm-lock.yaml'], "lockfileVersion: '9.0'\n");
  });

  it('runs nothing when the cut refuses, and exits 125', (t) => {
    const root = makeCheckout(t, { 'apps/web2-admin/package.json': manifestOf('beta', 'pnpm@10.29.3') });

    const { result, seen } = listIn(t, root);

    assert.equal(result.status, 125);
    assert.match(result.stderr, /pnpm@10\.29\.3/);
    assert.equal(seen, null);
  });

  it('refuses a root that is not a git checkout, and runs nothing', (t) => {
    const root = makeTempDir(t);
    writeFiles(root, realAppFiles());

    const { result, seen } = listIn(t, root);

    assert.equal(result.status, 125);
    assert.match(result.stderr, /git/);
    assert.equal(seen, null);
  });

  it('exits 125 with its usage when no command follows --', (t) => {
    const result = runScript(IN_COPY, ['--root', makeCheckout(t), '--app', 'apps/web2-admin', '--']);

    assert.equal(result.status, 125);
    assert.match(result.stderr, /Usage: node tools\/app-workspace\/in-copy\.mjs/);
  });
});
