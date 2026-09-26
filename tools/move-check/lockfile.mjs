import {
  CheckError,
  EXIT,
  UsageError,
  countOf,
  parseOptions,
  requireOption,
  runGit,
  runWhenStarted,
  showHelp,
  splitPair,
} from './lib/shared.mjs';

const USAGE = `Usage: node tools/move-check/lockfile.mjs --from <rev>:<path> --to <rev>:<path>
         [--importer <old>=<new>]...
       node tools/move-check/lockfile.mjs --packages --from <rev>:<path> --to <rev>:<path>

Compares two pnpm lockfiles read from git, for example --from main:pnpm-lock.yaml.

By default it renames, in the from file, each importer an --importer names. Those
are the keys two spaces deep under the top-level importers: map, and nothing else
is touched. The check passes only when the two texts are then identical byte for
byte, and otherwise prints the first differing lines with their numbers.

With --packages it compares the keys under packages: and snapshots: instead, and
lists the ones only one side has. That is for an upgrade, where the text is
expected to change but the set of resolved packages is not.

Exit codes: 0 match, 1 difference, 2 the check could not run.`;

const OPTION_SPECS = {
  from: { type: 'string' },
  to: { type: 'string' },
  importer: { type: 'string', multiple: true },
  packages: { type: 'boolean' },
};

const SECTION_KEY_INDENT = 2;
const MAX_SHOWN_LINES = 5;
const KEYED_SECTIONS = [
  { name: 'packages', singular: 'package key' },
  { name: 'snapshots', singular: 'snapshot key' },
];

function readSingleQuotedKey(body) {
  for (let index = 1; index < body.length; index += 1) {
    if (body[index] !== "'") continue;
    if (body[index + 1] === "'") {
      index += 1;
      continue;
    }
    return { value: body.slice(1, index).replaceAll("''", "'"), length: index + 1 };
  }
  return null;
}

function readDoubleQuotedKey(body) {
  for (let index = 1; index < body.length; index += 1) {
    if (body[index] === '\\') {
      index += 1;
      continue;
    }
    if (body[index] !== '"') continue;
    const quoted = body.slice(0, index + 1);
    try {
      return { value: JSON.parse(quoted), length: index + 1 };
    } catch {
      return { value: quoted.slice(1, -1), length: index + 1 };
    }
  }
  return null;
}

/** A plain YAML key ends at the first colon that a space or the end of the line follows. */
function readPlainKey(body) {
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === ':' && (index + 1 === body.length || body[index + 1] === ' ')) {
      return index === 0 ? null : { value: body.slice(0, index), length: index };
    }
  }
  return null;
}

function readKeyScalar(body) {
  if (body.startsWith("'")) return readSingleQuotedKey(body);
  if (body.startsWith('"')) return readDoubleQuotedKey(body);
  return readPlainKey(body);
}

/**
 * Reads the mapping key that starts a YAML block line: its indentation, its value without quotes,
 * and the index where its text ends. Returns null for any line that is not a `key:` line.
 */
export function parseYamlKey(line) {
  const content = line.endsWith('\r') ? line.slice(0, -1) : line;
  const indent = content.length - content.replace(/^ +/, '').length;
  const body = content.slice(indent);
  if (body === '' || body.startsWith('#') || body.startsWith('- ')) return null;
  const scalar = readKeyScalar(body);
  if (!scalar) return null;
  const afterKey = body.slice(scalar.length);
  if (afterKey !== ':' && !afterKey.startsWith(': ')) return null;
  return { indent, key: scalar.value, keyEnd: indent + scalar.length };
}

function startsTopLevelEntry(line) {
  return line !== '' && line !== '\r' && !/^[ \t#]/.test(line);
}

/** Finds the lines that belong to a top-level section, from the line after `name:` to the next top-level key. */
function findTopLevelSection(lines, name) {
  const header = lines.findIndex((line) => {
    const key = parseYamlKey(line);
    return key !== null && key.indent === 0 && key.key === name;
  });
  if (header === -1) return null;
  const next = lines.findIndex((line, index) => index > header && startsTopLevelEntry(line));
  return { start: header + 1, end: next === -1 ? lines.length : next };
}

function sectionKeyLines(lines, section) {
  return lines
    .map((line, index) => ({ index, key: parseYamlKey(line) }))
    .filter(({ index, key }) => index >= section.start && index < section.end && key?.indent === SECTION_KEY_INDENT);
}

/** Lists the keys two spaces deep in one top-level section, such as the packages under `packages:`. */
export function listSectionKeys(text, name) {
  const lines = text.split('\n');
  const section = findTopLevelSection(lines, name);
  return section ? sectionKeyLines(lines, section).map(({ key }) => key.key) : [];
}

/** Writes a new key in the quoting style of the key it replaces. */
function formatKeyLike(originalKeyText, name) {
  if (originalKeyText.startsWith("'")) return `'${name.replaceAll("'", "''")}'`;
  if (originalKeyText.startsWith('"')) return JSON.stringify(name);
  return name;
}

function checkRenames(importers, renames) {
  const unknown = [...renames.keys()].filter((name) => !importers.includes(name));
  if (unknown.length > 0) {
    throw new CheckError(
      `--importer names ${unknown.join(', ')}, which the from lockfile does not have. It has: ${importers.join(', ')}.`,
    );
  }
  const renamed = importers.map((name) => renames.get(name) ?? name);
  const repeated = renamed.find((name, index) => renamed.indexOf(name) !== index);
  if (repeated !== undefined) throw new CheckError(`--importer would leave two importers named ${repeated}.`);
}

/**
 * Renames the keys directly under the top-level `importers:` map and changes nothing else in the text.
 * @param {string} text
 * @param {Map<string, string>} renames old importer name to new
 */
export function renameImporters(text, renames) {
  if (renames.size === 0) return text;
  const lines = text.split('\n');
  const section = findTopLevelSection(lines, 'importers');
  if (!section) throw new CheckError('The from lockfile has no top-level importers: section to rename.');
  const keyLines = sectionKeyLines(lines, section);
  checkRenames(
    keyLines.map(({ key }) => key.key),
    renames,
  );
  const replacements = new Map(
    keyLines
      .filter(({ key }) => renames.has(key.key))
      .map(({ index, key }) => {
        const line = lines[index];
        const newKey = formatKeyLike(line.slice(key.indent, key.keyEnd), renames.get(key.key));
        return [index, `${line.slice(0, key.indent)}${newKey}${line.slice(key.keyEnd)}`];
      }),
  );
  return lines.map((line, index) => replacements.get(index) ?? line).join('\n');
}

/**
 * Finds the lines between the longest common start and the longest common end of two texts.
 * Returns null when the texts are identical.
 */
export function findFirstDifference(fromText, toText) {
  if (fromText === toText) return null;
  const fromLines = fromText.split('\n');
  const toLines = toText.split('\n');
  let start = 0;
  while (start < fromLines.length && start < toLines.length && fromLines[start] === toLines[start]) start += 1;
  let fromEnd = fromLines.length;
  let toEnd = toLines.length;
  while (fromEnd > start && toEnd > start && fromLines[fromEnd - 1] === toLines[toEnd - 1]) {
    fromEnd -= 1;
    toEnd -= 1;
  }
  return { lineNumber: start + 1, fromLines: fromLines.slice(start, fromEnd), toLines: toLines.slice(start, toEnd) };
}

function countLines(text) {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function formatSide(label, lines, firstLineNumber) {
  const prefix = `  ${label.padEnd(4)}`;
  if (lines.length === 0) return [`${prefix} ${firstLineNumber}: (no line here, the rest matches)`];
  const shown = lines.slice(0, MAX_SHOWN_LINES).map((line, offset) => `${prefix} ${firstLineNumber + offset}: ${JSON.stringify(line)}`);
  const hidden = lines.length - shown.length;
  return hidden > 0 ? [...shown, `${prefix} ... and ${countOf(hidden, 'more line')} up to the last difference`] : shown;
}

function readLockfile(spec, flag) {
  const separator = spec.indexOf(':');
  if (separator <= 0 || separator === spec.length - 1) throw new UsageError(`${flag} must name a file as <rev>:<path>, got "${spec}".`);
  let type;
  try {
    type = runGit(['cat-file', '-t', spec]).trim();
  } catch (error) {
    throw new CheckError(`${flag} ${spec} cannot be read.\n${error.message}`);
  }
  if (type !== 'blob') throw new CheckError(`${flag} ${spec} is a ${type}, not a file.`);
  const bytes = runGit(['show', '--no-textconv', spec], { encoding: 'buffer' });
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new CheckError(`${flag} ${spec} is not valid UTF-8 text.`);
  return text;
}

function parseImporterRenames(values = []) {
  const renames = new Map();
  for (const value of values) {
    const [from, to] = splitPair(value, '--importer');
    if (renames.has(from)) throw new UsageError(`--importer names "${from}" more than once.`);
    renames.set(from, to);
  }
  return renames;
}

function compareTexts(fromText, toText, renames) {
  const renamedText = renameImporters(fromText, renames);
  const difference = findFirstDifference(renamedText, toText);
  const renameNote = renames.size > 0 ? ` after renaming ${countOf(renames.size, 'importer')}` : '';
  if (difference === null) {
    console.log(`lockfile: match, identical byte for byte${renameNote} (${countOf(countLines(toText), 'line')})`);
    return EXIT.MATCH;
  }
  console.log(
    [
      `first difference at line ${difference.lineNumber}:`,
      ...formatSide('from', difference.fromLines, difference.lineNumber),
      ...formatSide('to', difference.toLines, difference.lineNumber),
      `the from side has ${countOf(countLines(renamedText), 'line')}${renameNote}, the to side has ${countLines(toText)}`,
      'lockfile: differs',
    ].join('\n'),
  );
  return EXIT.DIFFERENCE;
}

function onlyInFirst(first, second) {
  const others = new Set(second);
  return first.filter((key) => !others.has(key));
}

function comparePackageKeys(fromText, toText) {
  const sections = KEYED_SECTIONS.map(({ name, singular }) => {
    const fromKeys = listSectionKeys(fromText, name);
    const toKeys = listSectionKeys(toText, name);
    return { name, singular, total: toKeys.length, onlyInFrom: onlyInFirst(fromKeys, toKeys), onlyInTo: onlyInFirst(toKeys, fromKeys) };
  });
  const differing = sections.filter((section) => section.onlyInFrom.length + section.onlyInTo.length > 0);
  if (differing.length === 0) {
    const [packages, snapshots] = sections;
    console.log(`lockfile: match, the same ${countOf(packages.total, 'package')} and ${countOf(snapshots.total, 'snapshot')} on both sides`);
    return EXIT.MATCH;
  }
  const listed = sections.flatMap((section) =>
    [
      [`${section.name} only in from`, section.onlyInFrom],
      [`${section.name} only in to`, section.onlyInTo],
    ]
      .filter(([, keys]) => keys.length > 0)
      .flatMap(([title, keys]) => [`${title} (${keys.length}):`, ...keys.map((key) => `  ${key}`)]),
  );
  const keyCounts = differing.map((section) => section.onlyInFrom.length + section.onlyInTo.length);
  const tally = differing.map((section, index) => countOf(keyCounts[index], section.singular)).join(' and ');
  const verb = keyCounts.reduce((sum, count) => sum + count, 0) === 1 ? 'is' : 'are';
  console.log([...listed, `lockfile: differs, ${tally} ${verb} on one side only`].join('\n'));
  return EXIT.DIFFERENCE;
}

/** Runs the lockfile check with command-line arguments and returns its exit code. */
export async function main(argv) {
  const options = parseOptions(argv, OPTION_SPECS);
  if (options.help) return showHelp(USAGE);
  const fromSpec = requireOption(options, 'from');
  const toSpec = requireOption(options, 'to');
  if (options.packages && options.importer) throw new UsageError('--importer has no effect with --packages, so give one or the other.');
  const renames = parseImporterRenames(options.importer);
  const fromText = readLockfile(fromSpec, '--from');
  const toText = readLockfile(toSpec, '--to');
  return options.packages ? comparePackageKeys(fromText, toText) : compareTexts(fromText, toText, renames);
}

await runWhenStarted(import.meta.url, USAGE, main);
