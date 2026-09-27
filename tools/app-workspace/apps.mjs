/**
 * Each app the tool cuts, by its folder from the repository root, with the one setting its own workspace takes that
 * the root's does not.
 *
 * `injectWorkspacePackages` is on for the manager alone. Its image runs `pnpm deploy` without `--legacy`, and pnpm 10
 * and later refuse that unless injection is on for the whole workspace the deploy runs in. `dependenciesMeta.injected`
 * on the deployed package does not count, measured on pnpm 11.10.0 and 11.11.0. The admin and the stack deploy with
 * `--legacy`, which needs no injection, and keep their workspace packages linked as they always were.
 *
 * @type {Readonly<Record<string, Readonly<{ injectWorkspacePackages: boolean }>>>}
 */
export const APP_SETTINGS = Object.freeze({
  'apps/hls-stream': Object.freeze({ injectWorkspacePackages: false }),
  'apps/infra-manager': Object.freeze({ injectWorkspacePackages: true }),
  'apps/web2-admin': Object.freeze({ injectWorkspacePackages: false }),
});
