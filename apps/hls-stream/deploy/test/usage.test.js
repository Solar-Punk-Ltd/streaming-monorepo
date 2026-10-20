import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

after(removeSandboxes);

/**
 * The flags each script accepts, which its printed help must name.
 *
 * `--profile`, `--portSlot` and `--host` reach every script through `parse_profile_args` in `_lib.sh`,
 * and the rest through each script's own argument loop. An operator reads the help to learn what a
 * script takes, so a flag missing from it is a flag nobody uses.
 */
const FLAGS_IN_HELP = {
  'stop.sh': ['--profile', '--portSlot', '--host'],
  'clean.sh': ['--profile', '--portSlot', '--host', '--volumes', '--all', '--yes', '-y'],
  'health.sh': ['--profile', '--portSlot', '--host'],
  'deploy.sh': [
    '--profile',
    '--portSlot',
    '--host',
    '--release-label',
    '--release-commit',
    '--feed-owner',
    '--feed-topic',
    '--stamp-id',
  ],
};

/** Flags a script accepts and leaves out of its help on purpose. */
const FLAGS_KEPT_OUT_OF_HELP = {
  'deploy.sh': ['--private-key'],
};

function namesFlag(text, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])${escaped}(?![\\w-])`, 'm').test(text);
}

/** `health.sh` has no help flag of its own and prints its usage when it meets an argument it cannot read. */
async function helpOf(script) {
  const run = await runScript(makeSandbox(), script, ['--help']);
  return run.stdout;
}

describe('the deploy scripts print every flag they accept', () => {
  for (const [script, flags] of Object.entries(FLAGS_IN_HELP)) {
    it(`${script} names ${flags.join(', ')}`, async () => {
      const help = await helpOf(script);
      assert.ok(help.includes(`Usage: ${script}`), `${script} --help printed no usage line:\n${help}`);

      const missing = flags.filter((flag) => !namesFlag(help, flag));
      assert.deepEqual(missing, [], `${script} --help does not name ${missing.join(', ')}:\n${help}`);
    });
  }

  for (const [script, flags] of Object.entries(FLAGS_KEPT_OUT_OF_HELP)) {
    it(`${script} keeps ${flags.join(', ')} out of its help`, async () => {
      const help = await helpOf(script);

      const shown = flags.filter((flag) => namesFlag(help, flag));
      assert.deepEqual(shown, [], `${script} --help names ${shown.join(', ')}, which stays undocumented`);
    });
  }
});
