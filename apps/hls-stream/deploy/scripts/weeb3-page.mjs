/** weeb-3's own published deployment, the page the in-browser scripts drive unless WEEB3_PAGE names another. */
export const DEFAULT_WEEB3_PAGE = 'https://lat-murmeldjur.github.io/weeb-3/';

/**
 * The weeb-3 app page to drive, read from WEEB3_PAGE, so a pinned or self-hosted build can be
 * measured in place of the published one. Always ends with a slash, because callers join paths onto it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function weeb3Page(env = process.env) {
  const value = env.WEEB3_PAGE?.trim();
  if (!value) return DEFAULT_WEEB3_PAGE;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`WEEB3_PAGE must be an http or https address, got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`WEEB3_PAGE must be an http or https address, got ${JSON.stringify(value)}`);
  }
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}
