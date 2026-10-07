// Stands in for tools/release/tag.mjs in a sandbox, copied there under that name. It tags nothing: it records that it
// ran, and with what, in the journal.
import { appendFileSync } from 'node:fs';

appendFileSync(process.env.STUB_JOURNAL, `tag ${process.argv.slice(2).join(' ')}\n`);
