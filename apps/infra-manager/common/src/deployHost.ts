/**
 * The host a new deployment is created on, shared by the manager's request
 * schemas and the UI's inline validation so both refuse exactly the same values.
 *
 * It is `localhost` or the name of a Host block in the manager's ssh config,
 * never `user@host`. Deploying reaches a `user@host` target fine, but the
 * chequebook's Docker route opens `ssh -- <alias>` and refuses a name with `@`,
 * because ssh would read it as a destination rather than a Host block. A
 * deployment created that way runs and then cannot deposit, withdraw or read its
 * balance, and only a redeploy under an alias recovers it. So the `@` is refused
 * here, at create, before any money goes in.
 *
 * Deployments stored before this rule keep their `user@host` and can still be
 * started, stopped and deleted, because `targetAlias` still reads that form.
 */
export const DEPLOY_HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export const DEPLOY_HOST_MESSAGE =
  'must be "localhost" or an ssh alias from the manager\'s ssh config, like bee2, never user@host';
