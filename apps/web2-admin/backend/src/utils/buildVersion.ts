import type { VersionInfo } from '@streaming-monorepo/web2-admin-common';

/**
 * A label as tools/release/version.mjs names a build: a tag, `<tag>+<commits past it>` or the short commit, with
 * `-dirty` at the end for changes that were not committed. 96 characters hold its longest: an 80-character tag, a
 * count and `-dirty`.
 */
const VERSION_LABEL_RE = /^[A-Za-z0-9._+/-]{1,96}$/;
const VERSION_COMMIT_RE = /^[0-9a-f]{40}$/;

/**
 * `WEB2_ADMIN_VERSION` and `WEB2_ADMIN_COMMIT`, which deploy/deploy.sh builds into the api image. A value that is
 * unset, or not one a deploy builds in, is null rather than shown: the console then says it runs a development build
 * instead of naming one nobody made.
 */
export function versionFrom(env: Readonly<Record<string, string | undefined>>): VersionInfo {
  const label = env.WEB2_ADMIN_VERSION ?? '';
  const commit = env.WEB2_ADMIN_COMMIT ?? '';
  return {
    label: VERSION_LABEL_RE.test(label) ? label : null,
    commit: VERSION_COMMIT_RE.test(commit) ? commit : null,
  };
}
