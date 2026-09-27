import { CheckError } from './cli.mjs';

/**
 * @typedef {import('./rules.mjs').ProjectGraph} ProjectGraph
 * @typedef {import('./rules.mjs').Exception} Exception
 */

/** A dependency on a package from the registry, which Nx names `npm:<package>`. It is no project of the repository. */
const EXTERNAL_PACKAGE_PREFIX = 'npm:';
const EXCEPTION_KEYS = Object.freeze(['source', 'target', 'reason']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function parseJson(text, fileName) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CheckError(`${fileName} is not JSON: ${error.message}`);
  }
}

function readTags(name, data, fileName) {
  const tags = data?.tags ?? [];
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
    throw new CheckError(`${fileName}: project ${name} has tags that are not a list of strings.`);
  }
  return tags;
}

function readDependency(entry, name, projectNames, fileName) {
  const shaped = isPlainObject(entry) && [entry.source, entry.target, entry.type].every(isNonEmptyString);
  if (!shaped) {
    throw new CheckError(
      `${fileName}: a dependency listed under ${name} is not { source, target, type }: ${JSON.stringify(entry)}`,
    );
  }
  if (entry.source !== name)
    throw new CheckError(`${fileName}: a dependency listed under ${name} starts from ${entry.source}.`);
  if (entry.target.startsWith(EXTERNAL_PACKAGE_PREFIX)) return undefined;
  if (!projectNames.has(entry.target))
    throw new CheckError(`${fileName}: ${name} depends on ${entry.target}, which is not a project.`);
  return { source: entry.source, target: entry.target, type: entry.type };
}

/**
 * Reads the JSON that `nx graph --file=<file>.json` writes: `{ graph: { nodes, dependencies } }`, where every node is a
 * project with its tags under `data.tags`, and `dependencies` lists each project's dependencies on the others.
 * Anything that does not fit that shape stops the check, so a changed format fails loudly rather than passing empty.
 *
 * @returns {ProjectGraph}
 */
export function readGraph(text, fileName) {
  const document = parseJson(text, fileName);
  const graph = document?.graph;
  if (!isPlainObject(graph?.nodes))
    throw new CheckError(`${fileName} has no graph.nodes object, so it is not a file nx graph --file wrote.`);
  if (!isPlainObject(graph.dependencies)) {
    throw new CheckError(`${fileName} has no graph.dependencies object, so it is not a file nx graph --file wrote.`);
  }

  const projects = Object.entries(graph.nodes).map(([name, node]) => ({
    name,
    tags: readTags(name, node?.data, fileName),
  }));
  if (projects.length === 0)
    throw new CheckError(`${fileName} names no projects. Was nx graph run at the repository root?`);
  const projectNames = new Set(projects.map((project) => project.name));

  const dependencies = [];
  for (const [name, entries] of Object.entries(graph.dependencies)) {
    if (!projectNames.has(name))
      throw new CheckError(`${fileName} lists dependencies of ${name}, which is not a project.`);
    if (!Array.isArray(entries)) throw new CheckError(`${fileName}: the dependencies of ${name} are not a list.`);
    for (const entry of entries) {
      const dependency = readDependency(entry, name, projectNames, fileName);
      if (dependency !== undefined) dependencies.push(dependency);
    }
  }
  return { projects, dependencies };
}

/**
 * Reads an exceptions file: a JSON list of `{ source, target, reason }`, each naming one app that may depend on
 * another app of its own scope, and why.
 *
 * @returns {Exception[]}
 */
export function readExceptions(text, fileName) {
  const entries = parseJson(text, fileName);
  if (!Array.isArray(entries)) throw new CheckError(`${fileName} is not a list of { source, target, reason }.`);
  const seen = new Set();
  return entries.map((entry, index) => {
    const position = `entry ${index + 1} of ${fileName}`;
    if (!isPlainObject(entry) || !EXCEPTION_KEYS.every((key) => isNonEmptyString(entry[key]))) {
      throw new CheckError(`${position} needs a source, a target and a reason, each a non-empty string.`);
    }
    const unread = Object.keys(entry).filter((key) => !EXCEPTION_KEYS.includes(key));
    if (unread.length > 0) throw new CheckError(`${position} has a key the check does not read: ${unread.join(', ')}`);
    const pair = `${entry.source} -> ${entry.target}`;
    if (seen.has(pair)) throw new CheckError(`${fileName} names ${pair} twice.`);
    seen.add(pair);
    return { source: entry.source, target: entry.target, reason: entry.reason };
  });
}
