/**
 * @typedef {{ name: string, tags: string[] }} Project
 * @typedef {{ source: string, target: string, type: string }} Dependency
 * @typedef {{ projects: Project[], dependencies: Dependency[] }} ProjectGraph
 * @typedef {{ source: string, target: string, reason: string }} Exception
 * @typedef {{ scope: string, type: string }} Placement
 * @typedef {{ source: string, target: string, dependencyTypes: string[] }} Pair
 * @typedef {{ kind: 'tags', project: string, detail: string }} TagProblem
 * @typedef {{ kind: 'dependency', source: string, target: string, dependencyTypes: string[], rules: string[] }} DependencyProblem
 * @typedef {{ kind: 'exception', source: string, target: string, detail: string }} ExceptionProblem
 * @typedef {TagProblem | DependencyProblem | ExceptionProblem} Problem
 */

/** Every project carries exactly one `scope:<scope>` tag and one `type:<type>` tag from these lists. */
export const SCOPES = Object.freeze(['admin', 'manager', 'stack', 'shared', 'infra', 'tools']);
export const TYPES = Object.freeze(['app', 'lib']);

const SHARED_SCOPE = 'shared';
const APP_TYPE = 'app';

/** The three rules of the monorepo plan's section 2.1, in the order a problem lists them. */
export const RULES = Object.freeze({
  APP_TO_APP: 'an app depends on another app',
  OTHER_SCOPE: "a project depends on another scope's internals",
  SHARED_TO_APP: 'a shared package depends on an app',
});

const EXCEPTION_DETAILS = Object.freeze({
  UNKNOWN_PROJECT: 'names a project the graph does not have',
  ONLY_APP_TO_APP_IN_ONE_SCOPE: 'an exception covers only an app that depends on another app of its own scope',
  NO_SUCH_DEPENDENCY: 'the graph has no such dependency',
  BREAKS_NO_RULE: 'the dependency breaks no rule',
});

function compareText(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function comparePairs(left, right) {
  return compareText(left.source, right.source) || compareText(left.target, right.target);
}

function pairKey(source, target) {
  return `${source}\u0000${target}`;
}

/** Reads one kind of tag, `scope` or `type`, as its value, or as the problem that stops it being read. */
function readTag(project, kind, knownValues) {
  const tags = project.tags.filter((tag) => tag.startsWith(`${kind}:`)).toSorted(compareText);
  if (tags.length === 0) return { problem: `has no ${kind} tag` };
  if (tags.length > 1) return { problem: `has more than one ${kind} tag: ${tags.join(', ')}` };
  const value = tags[0].slice(kind.length + 1);
  if (!knownValues.includes(value)) return { problem: `has an unknown ${kind} tag: ${tags[0]}` };
  return { value };
}

/**
 * Places every project by its tags. A project whose tags cannot be read gets tag problems and no placement, so
 * none of its dependencies is judged until its tags are fixed.
 */
function placeProjects(projects) {
  /** @type {Map<string, Placement>} */
  const placements = new Map();
  /** @type {TagProblem[]} */
  const problems = [];
  for (const project of projects.toSorted((left, right) => compareText(left.name, right.name))) {
    const scope = readTag(project, 'scope', SCOPES);
    const type = readTag(project, 'type', TYPES);
    const tagProblems = [scope.problem, type.problem].filter((detail) => detail !== undefined);
    if (tagProblems.length === 0) placements.set(project.name, { scope: scope.value, type: type.value });
    problems.push(...tagProblems.map((detail) => ({ kind: 'tags', project: project.name, detail })));
  }
  return { placements, problems };
}

/** One entry per source and target, with every kind of dependency Nx recorded between them. */
function pairsOf(dependencies) {
  /** @type {Map<string, Pair>} */
  const pairs = new Map();
  for (const { source, target, type } of dependencies) {
    const key = pairKey(source, target);
    const pair = pairs.get(key) ?? { source, target, dependencyTypes: [] };
    if (!pair.dependencyTypes.includes(type)) pair.dependencyTypes.push(type);
    pairs.set(key, pair);
  }
  return pairs;
}

/** The rules a dependency of `source` on `target` breaks, in the order of RULES. */
function rulesBrokenBy(source, target) {
  const rules = [];
  if (source.type === APP_TYPE && target.type === APP_TYPE) rules.push(RULES.APP_TO_APP);
  if (source.scope !== target.scope && target.scope !== SHARED_SCOPE) rules.push(RULES.OTHER_SCOPE);
  if (source.scope === SHARED_SCOPE && target.type === APP_TYPE) rules.push(RULES.SHARED_TO_APP);
  return rules;
}

/**
 * Says why an exception cannot stand, or returns undefined when it covers a dependency it may cover. Returns
 * undefined as well when a project it names has unreadable tags, which are reported on their own.
 */
function exceptionDetail(exception, projectNames, placements, brokenRules) {
  const unknown = [exception.source, exception.target].find((name) => !projectNames.has(name));
  if (unknown !== undefined) return `${EXCEPTION_DETAILS.UNKNOWN_PROJECT}: ${unknown}`;
  const source = placements.get(exception.source);
  const target = placements.get(exception.target);
  if (source === undefined || target === undefined) return undefined;
  if (source.scope !== target.scope) return EXCEPTION_DETAILS.ONLY_APP_TO_APP_IN_ONE_SCOPE;
  const rules = brokenRules.get(pairKey(exception.source, exception.target));
  if (rules === undefined) return EXCEPTION_DETAILS.NO_SUCH_DEPENDENCY;
  if (rules.length === 0) return EXCEPTION_DETAILS.BREAKS_NO_RULE;
  if (rules.length > 1 || rules[0] !== RULES.APP_TO_APP) return EXCEPTION_DETAILS.ONLY_APP_TO_APP_IN_ONE_SCOPE;
  return undefined;
}

/**
 * Judges a project graph against the boundaries its tags draw, and every exception against the graph.
 * Returns every problem: projects whose tags cannot be read, then dependencies that break a rule, then exceptions
 * that do not stand. An empty list means the graph keeps to the boundaries.
 *
 * @param {ProjectGraph} graph dependencies between the graph's own projects only, external packages left out
 * @param {Exception[]} exceptions dependencies of one app on another app of its own scope, each let through by name
 * @returns {Problem[]}
 */
export function findProblems(graph, exceptions = []) {
  const { placements, problems: tagProblems } = placeProjects(graph.projects);
  const projectNames = new Set(graph.projects.map((project) => project.name));
  const pairs = pairsOf(graph.dependencies);

  /** @type {Map<string, string[]>} */
  const brokenRules = new Map();
  for (const [key, pair] of pairs) {
    const source = placements.get(pair.source);
    const target = placements.get(pair.target);
    if (source !== undefined && target !== undefined) brokenRules.set(key, rulesBrokenBy(source, target));
  }

  /** @type {ExceptionProblem[]} */
  const exceptionProblems = [];
  const excepted = new Set();
  for (const exception of exceptions) {
    const detail = exceptionDetail(exception, projectNames, placements, brokenRules);
    if (detail === undefined) excepted.add(pairKey(exception.source, exception.target));
    else exceptionProblems.push({ kind: 'exception', source: exception.source, target: exception.target, detail });
  }

  /** @type {DependencyProblem[]} */
  const dependencyProblems = [];
  for (const [key, pair] of pairs) {
    const rules = brokenRules.get(key) ?? [];
    if (rules.length === 0 || excepted.has(key)) continue;
    dependencyProblems.push({
      kind: 'dependency',
      source: pair.source,
      target: pair.target,
      dependencyTypes: pair.dependencyTypes.toSorted(compareText),
      rules,
    });
  }

  return [...tagProblems, ...dependencyProblems.toSorted(comparePairs), ...exceptionProblems.toSorted(comparePairs)];
}
