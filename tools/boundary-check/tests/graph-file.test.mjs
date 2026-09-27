import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { CheckError } from '../lib/cli.mjs';
import { readExceptions, readGraph } from '../lib/graph-file.mjs';

/**
 * Written by nx 23.2.1's `nx graph --file` over a three-project pnpm workspace: admin-app declares admin-lib in its
 * package.json, manager-app imports admin-lib without declaring it, manager-app imports a file of admin-app by a
 * relative path, and admin-app imports a file of manager-app both statically and with a dynamic import().
 */
const NX_23_GRAPH = readFileSync(new URL('fixtures/nx-23.2.1-graph.json', import.meta.url), 'utf8');

/** The shape `nx graph --file` writes, for the projects and dependencies given. */
function graphText(nodes, dependencies = {}) {
  const namedNodes = Object.fromEntries(
    Object.entries(nodes).map(([name, tags]) => [
      name,
      { name, type: 'lib', data: { root: `libs/${name}`, name, tags } },
    ]),
  );
  return JSON.stringify({ graph: { nodes: namedNodes, dependencies } });
}

function byName(left, right) {
  return left.name < right.name ? -1 : 1;
}

describe('readGraph', () => {
  it('reads the projects and the dependencies between them from the file nx 23.2.1 writes', () => {
    const graph = readGraph(NX_23_GRAPH, 'graph.json');
    assert.deepEqual(graph.projects.toSorted(byName), [
      { name: 'admin-app', tags: ['npm:private', 'scope:admin', 'type:app'] },
      { name: 'admin-lib', tags: ['npm:private', 'scope:admin', 'type:lib'] },
      { name: 'manager-app', tags: ['npm:private', 'scope:manager', 'type:app'] },
    ]);
    assert.deepEqual(
      graph.dependencies.map(({ source, target, type }) => `${source} -> ${target} ${type}`).toSorted(),
      [
        'admin-app -> admin-lib static',
        'admin-app -> manager-app dynamic',
        'admin-app -> manager-app static',
        'manager-app -> admin-app static',
        'manager-app -> admin-lib static',
      ],
    );
  });

  it('leaves out a dependency on an npm package, which is no project of the repository', () => {
    const text = graphText({ a: [] }, { a: [{ source: 'a', target: 'npm:express', type: 'static' }] });
    assert.deepEqual(readGraph(text, 'graph.json').dependencies, []);
  });

  it('reads a project without a tags list as a project without tags, which the rules then name', () => {
    const text = JSON.stringify({
      graph: { nodes: { a: { name: 'a', type: 'lib', data: { root: 'a' } } }, dependencies: { a: [] } },
    });
    assert.deepEqual(readGraph(text, 'graph.json').projects, [{ name: 'a', tags: [] }]);
  });

  const REFUSALS = [
    ['text that is not JSON', '{"graph":', /graph\.json is not JSON/],
    [
      'a document without graph.nodes',
      JSON.stringify({ graph: { dependencies: {} } }),
      /graph\.json has no graph\.nodes object/,
    ],
    [
      'a document without graph.dependencies',
      JSON.stringify({ graph: { nodes: {} } }),
      /graph\.json has no graph\.dependencies object/,
    ],
    ['a graph that names no projects', graphText({}), /graph\.json names no projects/],
    [
      'tags that are not a list of strings',
      graphText({ a: 'scope:admin' }),
      /project a has tags that are not a list of strings/,
    ],
    [
      'dependencies listed under a name that is no project',
      graphText({ a: [] }, { ghost: [] }),
      /lists dependencies of ghost, which is not a project/,
    ],
    [
      'a dependency listed under a project it does not start from',
      graphText({ a: [], b: [] }, { a: [{ source: 'b', target: 'a', type: 'static' }] }),
      /a dependency listed under a starts from b/,
    ],
    [
      'a dependency on a name that is neither a project nor an npm package',
      graphText({ a: [] }, { a: [{ source: 'a', target: 'ghost', type: 'static' }] }),
      /a depends on ghost, which is not a project/,
    ],
    [
      'a dependency that is not a source, a target and a type',
      graphText({ a: [], b: [] }, { a: [{ source: 'a', target: 'b' }] }),
      /a dependency listed under a is not \{ source, target, type \}/,
    ],
    ['dependencies that are not a list', graphText({ a: [] }, { a: {} }), /the dependencies of a are not a list/],
  ];

  for (const [what, text, message] of REFUSALS) {
    it(`refuses ${what}`, () => {
      assert.throws(
        () => readGraph(text, 'graph.json'),
        (error) => error instanceof CheckError && message.test(error.message),
      );
    });
  }
});

describe('readExceptions', () => {
  const EXCEPTION = {
    source: 'manager-frontend',
    target: 'manager-api',
    reason: 'the dev mocks reuse the API schemas',
  };

  it('reads a list of dependencies, each with its reason', () => {
    assert.deepEqual(readExceptions(JSON.stringify([EXCEPTION]), 'exceptions.json'), [EXCEPTION]);
  });

  it('reads an empty list', () => {
    assert.deepEqual(readExceptions('[]', 'exceptions.json'), []);
  });

  const REFUSALS = [
    ['text that is not JSON', '[', /exceptions\.json is not JSON/],
    ['a document that is not a list', JSON.stringify({ exceptions: [] }), /exceptions\.json is not a list/],
    [
      'an entry without a reason',
      JSON.stringify([{ source: 'a', target: 'b' }]),
      /entry 1 of exceptions\.json needs a source, a target and a reason/,
    ],
    [
      'an empty reason',
      JSON.stringify([{ ...EXCEPTION, reason: ' ' }]),
      /entry 1 of exceptions\.json needs a source, a target and a reason/,
    ],
    [
      'an entry with a key the check does not read',
      JSON.stringify([{ ...EXCEPTION, expires: 'never' }]),
      /entry 1 of exceptions\.json has a key the check does not read: expires/,
    ],
    [
      'the same dependency twice',
      JSON.stringify([EXCEPTION, EXCEPTION]),
      /exceptions\.json names manager-frontend -> manager-api twice/,
    ],
  ];

  for (const [what, text, message] of REFUSALS) {
    it(`refuses ${what}`, () => {
      assert.throws(
        () => readExceptions(text, 'exceptions.json'),
        (error) => error instanceof CheckError && message.test(error.message),
      );
    });
  }
});
