import { ADMIN_API_TOKEN_KEY, ADMIN_API_URL_KEY, type AdminLinkBefore } from '@streaming-infra-manager/common';

/** Where a deployment's two web2 admin keys stand before a save or a create changes them. */
export interface AdminLinkValues {
  /**
   * What the uploader would be given now, secrets in clear: what the next
   * deploy writes, for a deployment that exists, or what the version gives
   * one that does not yet.
   */
  current: Readonly<Record<string, string>>;
  /** What the version sets, which a reset of a stored value puts back. */
  version: Readonly<Record<string, string>>;
  /** The secrets the version requires, which the manager generates at a deploy wherever the version leaves one empty. */
  requiredSecrets: readonly string[];
  /**
   * The address the manager generates a token of the deployment's own for, `ownAdminTokenAddressOf` of its link,
   * or null for a deployment that runs no stream uploader or a manager with no link to register it with.
   */
  ownTokenFor?: string | null;
  /**
   * Whether the token in `current` is that generated one, which the next deploy writes only for an address on the
   * link's origin, so it is not counted as a token of its own wherever the address goes.
   */
  currentIsOwnToken?: boolean;
  /** Whether the deployment stores a value for `ADMIN_API_TOKEN`, typed or copied. None does before a create. */
  tokenStored?: boolean;
}

function filled(values: Readonly<Record<string, string>>, key: string): boolean {
  return (values[key] ?? '') !== '';
}

/**
 * The two keys as the rule of `adminLinkEditProblem` reads them. A token the version requires, which the manager
 * generates, is there however the version leaves it. The token of the deployment's own is there for the link's
 * address alone.
 */
export function adminLinkBeforeOf({
  current,
  version,
  requiredSecrets,
  ownTokenFor = null,
  currentIsOwnToken = false,
  tokenStored = false,
}: AdminLinkValues): AdminLinkBefore {
  const generated = requiredSecrets.includes(ADMIN_API_TOKEN_KEY);
  return {
    url: { current: current[ADMIN_API_URL_KEY] ?? '', afterReset: version[ADMIN_API_URL_KEY] ?? '' },
    token: {
      current: generated || (!currentIsOwnToken && filled(current, ADMIN_API_TOKEN_KEY)),
      afterReset: generated || filled(version, ADMIN_API_TOKEN_KEY),
      generatedFor: generated ? null : ownTokenFor,
      stored: tokenStored,
    },
  };
}
