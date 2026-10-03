#!/usr/bin/env node
/**
 * A stand-in for a Chrome that is slow to start, for chrome-start.test.mjs.
 *
 * It takes Chrome's flags, waits `SLOW_CHROME_DELAY_MS`, then writes the
 * `DevToolsActivePort` file into its profile the way Chrome does, and stays
 * running until it is signalled. The port it names has nothing listening, so a
 * launcher that waited long enough fails at its next step rather than at the
 * port wait, and the two failures tell the cases apart.
 *
 * A file in the repository rather than one written to a temporary directory,
 * because some containers mount that directory `noexec`.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const PROFILE_FLAG = '--user-data-dir=';
/** A port nothing listens on, so the launcher's request to it is refused at once. */
const UNUSED_PORT = 1;

const profile = process.argv.find((arg) => arg.startsWith(PROFILE_FLAG))?.slice(PROFILE_FLAG.length);
if (!profile) {
  process.stderr.write('slow-chrome: no --user-data-dir was given\n');
  process.exit(2);
}

setInterval(() => undefined, 60_000);
await delay(Number(process.env.SLOW_CHROME_DELAY_MS ?? 0));
await writeFile(join(profile, 'DevToolsActivePort'), `${UNUSED_PORT}\n/devtools/browser/slow-chrome\n`);
