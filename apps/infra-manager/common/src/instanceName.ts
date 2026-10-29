/** The most characters an instance name may have, so it fits the sidebar beside the build. */
export const INSTANCE_NAME_MAX_LENGTH = 40;

/** Letters, digits, `.`, `_` and `-`, which a page shows and a deploy writes into an env file without quoting. */
const INSTANCE_NAME_RE = new RegExp(`^[A-Za-z0-9._-]{1,${INSTANCE_NAME_MAX_LENGTH}}$`);

/**
 * The name a manager instance goes by, such as `my-instance`, from MANAGER_INSTANCE_NAME: trimmed, and null when it is
 * unset, blank or of another shape. The manager answers it on `GET /config` and the sidebar shows it beside the build.
 */
export function instanceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return INSTANCE_NAME_RE.test(value) ? value : null;
}
