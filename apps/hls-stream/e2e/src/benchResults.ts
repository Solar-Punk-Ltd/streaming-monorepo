/**
 * Where a measurement run writes its reports, json and screenshots.
 *
 * Results are a deployment's own data, so they never land in a tracked folder. `BENCH_RESULTS_DIR`
 * names the folder. A relative value is read against the checkout. Unset, it is
 * {@link BENCH_RESULTS_DEFAULT_DIR} under the checkout, which `.gitignore` excludes.
 *
 * ⛔ A run inside the bench container must write under the checkout it was mounted from, because the
 * harness reads the artifact back through that mount. Leave the setting unset there, or relative.
 */

import { isAbsolute, join, resolve } from 'node:path';

import { ROOT_DIR } from './config.js';

export const BENCH_RESULTS_DEFAULT_DIR = 'bench-results';

export function benchResultsDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  rootDir: string = ROOT_DIR,
): string {
  const configured = env.BENCH_RESULTS_DIR;
  if (configured === undefined || configured === '') {
    return join(rootDir, BENCH_RESULTS_DEFAULT_DIR);
  }
  return isAbsolute(configured) ? configured : resolve(rootDir, configured);
}
