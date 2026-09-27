import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RULES, findProblems } from '../lib/rules.mjs';

/** A project as the check sees it: its name and its Nx tags. */
function project(name, scope, type, ...otherTags) {
  return { name, tags: [`scope:${scope}`, `type:${type}`, ...otherTags] };
}

/** Dependencies are `[source, target]` or `[source, target, type]`, static unless named. */
function graphOf(projects, dependencies = []) {
  return {
    projects,
    dependencies: dependencies.map(([source, target, type = 'static']) => ({ source, target, type })),
  };
}

const ADMIN_BACKEND = project('admin-backend', 'admin', 'app');
const ADMIN_COMMON = project('admin-common', 'admin', 'lib');
const MANAGER_API = project('manager-api', 'manager', 'app');
const MANAGER_FRONTEND = project('manager-frontend', 'manager', 'app');
const MANAGER_COMMON = project('manager-common', 'manager', 'lib');
const STACK_UPLOADER = project('stack-uploader', 'stack', 'app');
const STACK_SHARED = project('stack-shared', 'stack', 'lib');
const CONTRACTS = project('contracts', 'shared', 'lib');
const CONTRACT_HELPERS = project('contract-helpers', 'shared', 'lib');
const MOVE_CHECK = project('move-check', 'tools', 'app');

const EVERY_PROJECT = [
  ADMIN_BACKEND,
  ADMIN_COMMON,
  MANAGER_API,
  MANAGER_FRONTEND,
  MANAGER_COMMON,
  STACK_UPLOADER,
  STACK_SHARED,
  CONTRACTS,
  CONTRACT_HELPERS,
  MOVE_CHECK,
];

/** The problems a graph of every project above has, given only these dependencies. */
function problemsOf(dependencies, exceptions) {
  return findProblems(graphOf(EVERY_PROJECT, dependencies), exceptions);
}

function dependencyProblem(source, target, rules, dependencyTypes = ['static']) {
  return { kind: 'dependency', source, target, dependencyTypes, rules };
}

describe('findProblems: dependencies that keep to the boundaries', () => {
  it('finds nothing when every project depends on its own libraries and on shared ones', () => {
    const problems = problemsOf([
      ['admin-backend', 'admin-common'],
      ['manager-api', 'manager-common'],
      ['manager-frontend', 'manager-common'],
      ['stack-uploader', 'stack-shared'],
      ['stack-uploader', 'contracts'],
      ['admin-backend', 'contracts'],
      ['admin-common', 'contracts'],
      ['contracts', 'contract-helpers'],
      ['move-check', 'contracts'],
    ]);
    assert.deepEqual(problems, []);
  });

  it('finds nothing in a graph without dependencies', () => {
    assert.deepEqual(problemsOf([]), []);
  });

  it('ignores tags that name neither a scope nor a type', () => {
    const graph = graphOf([project('admin-backend', 'admin', 'app', 'e2e', 'owner:web2'), ADMIN_COMMON], [['admin-backend', 'admin-common']]);
    assert.deepEqual(findProblems(graph), []);
  });
});

describe('findProblems: an app depends on another app', () => {
  it('names an app that depends on an app of another scope, which also reaches into that scope', () => {
    assert.deepEqual(problemsOf([['admin-backend', 'manager-api']]), [
      dependencyProblem('admin-backend', 'manager-api', [RULES.APP_TO_APP, RULES.OTHER_SCOPE]),
    ]);
  });

  it('names an app that depends on another app of its own scope', () => {
    assert.deepEqual(problemsOf([['manager-frontend', 'manager-api']]), [
      dependencyProblem('manager-frontend', 'manager-api', [RULES.APP_TO_APP]),
    ]);
  });
});

describe("findProblems: a project depends on another scope's internals", () => {
  it("names an app that depends on another app scope's library", () => {
    assert.deepEqual(problemsOf([['stack-uploader', 'admin-common']]), [
      dependencyProblem('stack-uploader', 'admin-common', [RULES.OTHER_SCOPE]),
    ]);
  });

  it("names a library that depends on another scope's library", () => {
    assert.deepEqual(problemsOf([['manager-common', 'admin-common']]), [
      dependencyProblem('manager-common', 'admin-common', [RULES.OTHER_SCOPE]),
    ]);
  });

  it('names a tool that depends on an app', () => {
    assert.deepEqual(problemsOf([['move-check', 'stack-uploader']]), [
      dependencyProblem('move-check', 'stack-uploader', [RULES.APP_TO_APP, RULES.OTHER_SCOPE]),
    ]);
  });

  it('names an app that depends on a tool', () => {
    assert.deepEqual(problemsOf([['stack-uploader', 'move-check']]), [
      dependencyProblem('stack-uploader', 'move-check', [RULES.APP_TO_APP, RULES.OTHER_SCOPE]),
    ]);
  });

  it("names a shared library that depends on an app scope's library", () => {
    assert.deepEqual(problemsOf([['contracts', 'stack-shared']]), [
      dependencyProblem('contracts', 'stack-shared', [RULES.OTHER_SCOPE]),
    ]);
  });
});

describe('findProblems: a shared package depends on an app', () => {
  it('names a shared library that depends on an app, which also reaches into that scope', () => {
    assert.deepEqual(problemsOf([['contracts', 'stack-uploader']]), [
      dependencyProblem('contracts', 'stack-uploader', [RULES.OTHER_SCOPE, RULES.SHARED_TO_APP]),
    ]);
  });

  it('names a shared library that depends on a shared app', () => {
    const sharedApp = project('shared-app', 'shared', 'app');
    const graph = graphOf([CONTRACTS, sharedApp], [['contracts', 'shared-app']]);
    assert.deepEqual(findProblems(graph), [dependencyProblem('contracts', 'shared-app', [RULES.SHARED_TO_APP])]);
  });
});

describe('findProblems: every kind of dependency counts', () => {
  for (const type of ['static', 'dynamic', 'implicit']) {
    it(`names a ${type} dependency that breaks a rule`, () => {
      assert.deepEqual(problemsOf([['admin-backend', 'manager-common', type]]), [
        dependencyProblem('admin-backend', 'manager-common', [RULES.OTHER_SCOPE], [type]),
      ]);
    });
  }

  it('names a pair once, with every kind of dependency between them', () => {
    const problems = problemsOf([
      ['admin-backend', 'manager-common', 'static'],
      ['admin-backend', 'manager-common', 'implicit'],
      ['admin-backend', 'manager-common', 'static'],
    ]);
    assert.deepEqual(problems, [dependencyProblem('admin-backend', 'manager-common', [RULES.OTHER_SCOPE], ['implicit', 'static'])]);
  });

  it('names every broken dependency, sorted by source and then target', () => {
    const problems = problemsOf([
      ['stack-uploader', 'admin-common'],
      ['admin-backend', 'stack-shared'],
      ['admin-backend', 'manager-common'],
    ]);
    assert.deepEqual(
      problems.map((problem) => `${problem.source} -> ${problem.target}`),
      ['admin-backend -> manager-common', 'admin-backend -> stack-shared', 'stack-uploader -> admin-common'],
    );
  });
});

describe('findProblems: every project carries one scope and one type', () => {
  function tagProblemsOf(tags) {
    return findProblems(graphOf([{ name: 'new-package', tags }]));
  }

  it('names a project with no tags at all', () => {
    assert.deepEqual(tagProblemsOf([]), [
      { kind: 'tags', project: 'new-package', detail: 'has no scope tag' },
      { kind: 'tags', project: 'new-package', detail: 'has no type tag' },
    ]);
  });

  it('names a project with two scopes', () => {
    assert.deepEqual(tagProblemsOf(['scope:admin', 'scope:shared', 'type:lib']), [
      { kind: 'tags', project: 'new-package', detail: 'has more than one scope tag: scope:admin, scope:shared' },
    ]);
  });

  it('names a project with two types', () => {
    assert.deepEqual(tagProblemsOf(['scope:admin', 'type:app', 'type:lib']), [
      { kind: 'tags', project: 'new-package', detail: 'has more than one type tag: type:app, type:lib' },
    ]);
  });

  it('names a scope or a type that is not one of the known ones', () => {
    assert.deepEqual(tagProblemsOf(['scope:stak', 'type:service']), [
      { kind: 'tags', project: 'new-package', detail: 'has an unknown scope tag: scope:stak' },
      { kind: 'tags', project: 'new-package', detail: 'has an unknown type tag: type:service' },
    ]);
  });

  it('judges no dependency of a project whose tags are wrong, and says so only once', () => {
    const untagged = { name: 'new-package', tags: ['type:lib'] };
    const graph = graphOf([untagged, ADMIN_BACKEND], [
      ['admin-backend', 'new-package'],
      ['new-package', 'admin-backend'],
    ]);
    assert.deepEqual(findProblems(graph), [{ kind: 'tags', project: 'new-package', detail: 'has no scope tag' }]);
  });

  it('lists tag problems before dependency problems', () => {
    const graph = graphOf([{ name: 'zz-untagged', tags: [] }, ADMIN_BACKEND, MANAGER_API], [['admin-backend', 'manager-api']]);
    assert.deepEqual(
      findProblems(graph).map((problem) => problem.kind),
      ['tags', 'tags', 'dependency'],
    );
  });
});

describe('findProblems: an exception for an app that depends on another app of its own scope', () => {
  const FRONTEND_ON_API = { source: 'manager-frontend', target: 'manager-api', reason: 'the dev mocks reuse the API schemas' };

  it('lets exactly that dependency through', () => {
    assert.deepEqual(problemsOf([['manager-frontend', 'manager-api']], [FRONTEND_ON_API]), []);
  });

  it('does not let the dependency the other way through', () => {
    assert.deepEqual(problemsOf([['manager-frontend', 'manager-api'], ['manager-api', 'manager-frontend']], [FRONTEND_ON_API]), [
      dependencyProblem('manager-api', 'manager-frontend', [RULES.APP_TO_APP]),
    ]);
  });

  it('names an exception whose dependency is gone', () => {
    assert.deepEqual(problemsOf([], [FRONTEND_ON_API]), [
      { kind: 'exception', source: 'manager-frontend', target: 'manager-api', detail: 'the graph has no such dependency' },
    ]);
  });

  it('names an exception whose dependency breaks no rule any more', () => {
    const graph = graphOf([MANAGER_FRONTEND, project('manager-api', 'manager', 'lib')], [['manager-frontend', 'manager-api']]);
    assert.deepEqual(findProblems(graph, [FRONTEND_ON_API]), [
      { kind: 'exception', source: 'manager-frontend', target: 'manager-api', detail: 'the dependency breaks no rule' },
    ]);
  });

  it('names an exception for a project the graph does not have', () => {
    const exception = { source: 'manager-frontend', target: 'manager-gone', reason: 'removed since' };
    assert.deepEqual(problemsOf([], [exception]), [
      { kind: 'exception', source: 'manager-frontend', target: 'manager-gone', detail: 'names a project the graph does not have: manager-gone' },
    ]);
  });

  it('refuses to cover a dependency that reaches into another scope, and still names the dependency', () => {
    const exception = { source: 'admin-backend', target: 'manager-api', reason: 'a shortcut' };
    assert.deepEqual(problemsOf([['admin-backend', 'manager-api']], [exception]), [
      dependencyProblem('admin-backend', 'manager-api', [RULES.APP_TO_APP, RULES.OTHER_SCOPE]),
      {
        kind: 'exception',
        source: 'admin-backend',
        target: 'manager-api',
        detail: 'an exception covers only an app that depends on another app of its own scope',
      },
    ]);
  });

  it('refuses to cover a dependency into another scope before the graph has it', () => {
    const exception = { source: 'stack-uploader', target: 'admin-common', reason: 'planned' };
    assert.deepEqual(problemsOf([], [exception]), [
      {
        kind: 'exception',
        source: 'stack-uploader',
        target: 'admin-common',
        detail: 'an exception covers only an app that depends on another app of its own scope',
      },
    ]);
  });

  it('refuses to cover a shared package that depends on a shared app, and still names the dependency', () => {
    const sharedApp = project('shared-app', 'shared', 'app');
    const exception = { source: 'contracts', target: 'shared-app', reason: 'a shortcut' };
    const problems = findProblems(graphOf([CONTRACTS, sharedApp], [['contracts', 'shared-app']]), [exception]);
    assert.deepEqual(problems, [
      dependencyProblem('contracts', 'shared-app', [RULES.SHARED_TO_APP]),
      {
        kind: 'exception',
        source: 'contracts',
        target: 'shared-app',
        detail: 'an exception covers only an app that depends on another app of its own scope',
      },
    ]);
  });
});
