import { collectChecks } from './collectChecks.js';
import { collectDiff } from './collectDiff.js';
import { collectProvenance } from './collectProvenance.js';
import { readCommandLine } from './commandLine.js';
import { formatFacts, hasFailure } from './formatFacts.js';
import { resolveBase } from './resolveBase.js';
import { run } from './run.js';
import type { GateFacts } from './types.js';

async function main(): Promise<void> {
  const { base: requestedBase, head: supplied } = readCommandLine(process.argv);
  // Resolved rather than echoed, so the artifact names a commit and not a branch that has since moved.
  const resolved = await run('git', ['rev-parse', '--short', supplied ?? 'HEAD']);
  if (resolved.exitCode !== 0) {
    throw new Error(`could not resolve ${supplied ?? 'HEAD'}: ${resolved.stderr.trim()}`);
  }
  const head = resolved.stdout.trim();

  // Resolved once and handed to both collectors that read it, so the diff and the lockfile come from the
  // same base, also where it exists only as `origin/<base>`. The base and then the diff run first and
  // alone, so a base that does not resolve or a diff that cannot be collected stops the run before the
  // slow collectors start. Nothing reads the diff to decide whether they are owed: both always run, side
  // by side.
  const base = await resolveBase(requestedBase);
  const diff = await collectDiff(base, head);
  const [checks, provenance] = await Promise.all([collectChecks(process.cwd()), collectProvenance(base, head)]);

  const facts: GateFacts = {
    base: requestedBase,
    head,
    headSupplied: supplied !== undefined,
    groups: [diff, checks, ...(provenance ? [provenance] : [])],
    authorMeasured: [],
  };

  console.log(formatFacts(facts));

  if (hasFailure(facts)) {
    // A non-zero exit here means a collected check failed for a reason not already registered. The
    // artifact is still printed above, because a reviewer needs to see which row it was.
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  // A collector that could not measure must never fall through to a clean-looking artifact. Nothing
  // is printed, and the exit code says so.
  console.error(`Gate facts could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
