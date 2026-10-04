import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/** The names Chrome and Chromium packages put on PATH, best first. The browser image installs the first. */
const BROWSER_NAMES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'] as const;

/**
 * The Chrome the harness launches: the one BROWSER_CHROME_PATH names, or else the first of the usual names
 * found on PATH. A Chrome that is on no PATH, such as the macOS app bundle, is named in BROWSER_CHROME_PATH.
 */
export function chromePath(env: NodeJS.ProcessEnv = process.env): string {
  const named = env.BROWSER_CHROME_PATH?.trim();
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
  throw new Error(`No Chrome found: set BROWSER_CHROME_PATH, or put one of ${BROWSER_NAMES.join(', ')} on PATH`);
}
