import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const SCRIPT = fileURLToPath(new URL('../boundaries.mjs', import.meta.url));
const NX_23_GRAPH = fileURLToPath(new URL('fixtures/nx-23.2.1-graph.json', import.meta.url));

/** Runs the check the way a workflow does and captures both streams and the exit code. */
function runCheck(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Writes files given as `{ name: content }` into a directory removed when the test ends, and returns their paths. */
function writeTempFiles(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'boundary-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Object.fromEntries(
    Object.entries(files).map(([name, content]) => {
      const path = join(dir, name);
      writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
      return [name, path];
    }),
  );
}

/** A graph in the shape `nx graph --file` writes, from `{ name: [tags] }` and `[source, target]` pairs. */
function nxGraph(projects, pairs) {
  const nodes = Object.fromEntries(
    Object.entries(projects).map(([name, tags]) => [
      name,
      { name, type: 'app', data: { root: `apps/${name}`, name, tags } },
    ]),
  );
  const dependencies = Object.fromEntries(Object.keys(projects).map((name) => [name, []]));
  for (const [source, target] of pairs) dependencies[source].push({ source, target, type: 'static' });
  return { graph: { nodes, dependencies } };
}

const MANAGER = {
  'manager-api': ['npm:private', 'scope:manager', 'type:app'],
  'manager-frontend': ['npm:private', 'scope:manager', 'type:app'],
  'manager-common': ['npm:private', 'scope:manager', 'type:lib'],
};

describe('boundaries.mjs', () => {
  it('exits 0 with one line when every dependency keeps to the boundaries', (t) => {
    const files = writeTempFiles(t, {
      'graph.json': nxGraph(MANAGER, [
        ['manager-api', 'manager-common'],
        ['manager-frontend', 'manager-common'],
      ]),
    });
    const result = runCheck(['--graph', files['graph.json']]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'boundaries: kept, 3 projects, 2 dependencies between them\n');
    assert.equal(result.stderr, '');
  });

  it('exits 1 on the graph nx 23.2.1 wrote, naming every broken dependency and the rules it breaks', () => {
    const result = runCheck(['--graph', NX_23_GRAPH]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      result.stdout,
      [
        "admin-app -> manager-app (dynamic, static): an app depends on another app and a project depends on another scope's internals",
        "manager-app -> admin-app (static): an app depends on another app and a project depends on another scope's internals",
        "manager-app -> admin-lib (static): a project depends on another scope's internals",
        'boundaries: broken, 3 problems',
        '',
      ].join('\n'),
    );
  });

  it('names a project whose tags cannot be read', (t) => {
    const files = writeTempFiles(t, { 'graph.json': nxGraph({ 'new-package': ['npm:private', 'type:lib'] }, []) });
    const result = runCheck(['--graph', files['graph.json']]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, 'new-package has no scope tag\nboundaries: broken, 1 problem\n');
  });

  it('lets an exception through and counts it', (t) => {
    const files = writeTempFiles(t, {
      'graph.json': nxGraph(MANAGER, [['manager-frontend', 'manager-api']]),
      'exceptions.json': [
        { source: 'manager-frontend', target: 'manager-api', reason: 'the dev mocks reuse the API schemas' },
      ],
    });
    const result = runCheck(['--graph', files['graph.json'], '--exceptions', files['exceptions.json']]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'boundaries: kept, 3 projects, 1 dependency between them, 1 exception\n');
  });

  it('exits 1 when an exception no longer matches the graph', (t) => {
    const files = writeTempFiles(t, {
      'graph.json': nxGraph(MANAGER, []),
      'exceptions.json': [
        { source: 'manager-frontend', target: 'manager-api', reason: 'the dev mocks reuse the API schemas' },
      ],
    });
    const result = runCheck(['--graph', files['graph.json'], '--exceptions', files['exceptions.json']]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      result.stdout,
      'the exception for manager-frontend -> manager-api: the graph has no such dependency\nboundaries: broken, 1 problem\n',
    );
  });

  it('exits 2 and says why when the graph file does not exist', (t) => {
    const files = writeTempFiles(t, { 'placeholder.txt': '' });
    const missing = join(files['placeholder.txt'], '..', 'graph.json');
    const result = runCheck(['--graph', missing]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /cannot read .*graph\.json/);
    assert.equal(result.stdout, '');
  });

  it('exits 2 and says why when the graph file is not a graph', (t) => {
    const files = writeTempFiles(t, { 'graph.json': '{"graph": {}}' });
    const result = runCheck(['--graph', files['graph.json']]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /has no graph\.nodes object/);
  });

  it('exits 2 and prints the usage when --graph is missing', () => {
    const result = runCheck([]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--graph is required/);
    assert.match(result.stderr, /Usage: node tools\/boundary-check\/boundaries\.mjs/);
  });

  it('exits 2 and prints the usage for an option it does not know', () => {
    const result = runCheck(['--graph', NX_23_GRAPH, '--strict']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: node tools\/boundary-check\/boundaries\.mjs/);
  });

  it('prints the usage for --help and exits 0', () => {
    const result = runCheck(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: node tools\/boundary-check\/boundaries\.mjs --graph <file>/);
  });
});
