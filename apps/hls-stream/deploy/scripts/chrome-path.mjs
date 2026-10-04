import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/** The names Chrome and Chromium packages put on PATH, best first. */
const BROWSER_NAMES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];

/**
 * The Chrome to start: the one CHROME_PATH names, or else the first of the usual names found on PATH.
 * A Chrome that is on no PATH, such as the macOS app bundle, is named in CHROME_PATH.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function chromePath(env = process.env) {
  const named = env.CHROME_PATH?.trim();
  if (named) return named;
  for (const name of BROWSER_NAMES) {
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* not here, so the next folder is asked */
      }
    }
  }
  throw new Error(`No Chrome found: set CHROME_PATH, or put one of ${BROWSER_NAMES.join(', ')} on PATH`);
}
