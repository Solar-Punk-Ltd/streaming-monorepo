/**
 * Which build of the admin is running. deploy/deploy.sh names the build with tools/release/version.mjs, from the git
 * tag the operator chose, and builds both values into the api image, so a container that was not replaced goes on
 * reporting the build it runs.
 */

/** `GET`, behind the session like every console route: the build is for signed-in users only. */
export const VERSION_PATH = '/api/version';

/** GET /api/version. Each value is null when the image carries none, as in a development run. */
export interface VersionInfo {
  /**
   * The tag on the deployed commit. On a commit without one, the nearest tag before it and how many commits the build
   * is past it (`QA-build-2026-10-07+3`), or the short commit when no tag is behind it. `-dirty` ends it when the
   * deploy sent changes that were not committed.
   */
  label: string | null;
  /** The commit the build was made from, 40 lowercase hex characters. */
  commit: string | null;
}
