import { readFileSync } from 'node:fs';

import { CheckError, EXIT, countOf, parseOptions, requireOption, runWhenStarted, showHelp } from './lib/cli.mjs';
import { readExceptions, readGraph } from './lib/graph-file.mjs';
import { findProblems } from './lib/rules.mjs';

const USAGE = `Usage: node tools/boundary-check/boundaries.mjs --graph <file> [--exceptions <file>]

Reads the project graph that \`nx graph --file=<file>.json\` writes and checks every
dependency between the repository's projects against the boundaries their tags draw.
Every project carries one scope tag, scope:admin, scope:manager, scope:stack,
scope:shared, scope:infra or scope:tools, and one type tag, type:app or type:lib, in
the nx field of its package.json.

It fails when an app depends on another app, when a project depends on a project of
another scope that is not shared, or when a shared package depends on an app.

  --graph       the JSON file nx graph --file wrote.
  --exceptions  a JSON list of { source, target, reason }, each an app that may depend
                on another app of its own scope. An entry that no longer matches a
                dependency the rules refuse fails the check.

nx graph --file writes a partial graph and exits 0 when the project graph has errors,
so run \`nx show projects\` first, which exits 1 on them.

Exit codes: 0 kept, 1 broken, 2 the check could not run.`;

const OPTION_SPECS = {
  graph: { type: 'string' },
  exceptions: { type: 'string' },
};

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new CheckError(`cannot read ${path}: ${error.message}`);
  }
}

/** One line per problem, written so the pair it names can be found with a plain text search. */
function describeProblem(problem) {
  if (problem.kind === 'tags') return `${problem.project} ${problem.detail}`;
  if (problem.kind === 'dependency') {
    return `${problem.source} -> ${problem.target} (${problem.dependencyTypes.join(', ')}): ${problem.rules.join(' and ')}`;
  }
  return `the exception for ${problem.source} -> ${problem.target}: ${problem.detail}`;
}

function countPairs(dependencies) {
  return new Set(dependencies.map(({ source, target }) => `${source}\u0000${target}`)).size;
}

/** Runs the check with command-line arguments and returns its exit code. */
export async function main(argv) {
  const options = parseOptions(argv, OPTION_SPECS);
  if (options.help) return showHelp(USAGE);
  const graphPath = requireOption(options, 'graph');
  const graph = readGraph(readText(graphPath), graphPath);
  const exceptions =
    options.exceptions === undefined ? [] : readExceptions(readText(options.exceptions), options.exceptions);

  const problems = findProblems(graph, exceptions);
  if (problems.length > 0) {
    console.log(
      [...problems.map(describeProblem), `boundaries: broken, ${countOf(problems.length, 'problem')}`].join('\n'),
    );
    return EXIT.BROKEN;
  }
  const parts = [
    'boundaries: kept',
    countOf(graph.projects.length, 'project'),
    `${countOf(countPairs(graph.dependencies), 'dependency', 'dependencies')} between them`,
  ];
  if (exceptions.length > 0) parts.push(countOf(exceptions.length, 'exception'));
  console.log(parts.join(', '));
  return EXIT.KEPT;
}

await runWhenStarted(import.meta.url, USAGE, main);
