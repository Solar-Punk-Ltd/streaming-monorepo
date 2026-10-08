// Stands in for tools/release/version.mjs in a sandbox, copied there under that name. It prints the five lines for
// the build the test names in FAKE_VERSION_COMMIT, FAKE_VERSION_TAG and FAKE_VERSION_LABEL, and records how it was
// asked in the journal. FAKE_VERSION_FAILS makes it fail as the real one does, with that message.
import { appendFileSync } from 'node:fs';

const env = process.env;
appendFileSync(env.STUB_JOURNAL, `version ${process.argv.slice(2).join(' ')}\n`);

if (env.FAKE_VERSION_FAILS) {
  process.stderr.write(`version: ${env.FAKE_VERSION_FAILS}\n`);
  process.exit(1);
}

const commit = env.FAKE_VERSION_COMMIT ?? '';
const tag = env.FAKE_VERSION_TAG ?? '';
const label = env.FAKE_VERSION_LABEL ?? (tag || commit.slice(0, 9));
process.stdout.write(
  `${[
    `VERSION_COMMIT=${commit}`,
    `VERSION_SHORT=${commit.slice(0, 9)}`,
    `VERSION_TAG=${tag}`,
    `VERSION_LABEL=${label}`,
    `VERSION_DIRTY=${label.endsWith('-dirty')}`,
  ].join('\n')}\n`,
);
