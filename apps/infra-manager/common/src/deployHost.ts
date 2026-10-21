/**
 * The host a new deployment is created on, shared by the manager's request
 * schemas and the UI's inline validation so both refuse exactly the same values.
 *
 * It is `localhost` or the name of a Host block in the manager's ssh config,
 * never `user@host`. A Host block keeps the user, the port and the key for a
 * host in one place, the manager's ssh config, so every deployment on that
 * host reaches it the same way and moving the host means editing one block.
 *
 * Deployments stored before this rule keep their `user@host` and can still be
 * started, stopped and deleted, because `targetAlias` still reads that form.
 */
export const DEPLOY_HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export const DEPLOY_HOST_MESSAGE =
  'must be "localhost" or an ssh alias from the manager\'s ssh config, like bee2, never user@host';
