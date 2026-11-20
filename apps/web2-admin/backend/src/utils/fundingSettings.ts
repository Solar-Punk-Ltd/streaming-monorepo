import { MANAGER_API_TOKEN_KEY } from '@streaming-monorepo/contracts';

/**
 * The rules of the admin's funding settings (docs/architecture/funding.md): the secret the brand wallet's key is
 * encrypted under, where the manager's funding API is, and the bearer token it takes, the manager's API token. The
 * config refuses a value that breaks one at boot, and the brand wallet and the manager funding client check what they
 * are given against the same rules. Each rule answers a sentence that names the key and never the value, or null.
 *
 * The address is `MANAGER_API_URL`, read as `MANAGER_FUNDING_URL` when unset ({@link managerApiUrlFrom}), and the
 * token is `MANAGER_API_TOKEN`, read as `MANAGER_FUNDING_TOKEN` when unset (`managerApiTokenFrom` of the contracts).
 * A sentence about either names the key it was read under.
 */

export const BRAND_WALLET_SECRET_KEY = 'BRAND_WALLET_SECRET';
export const MANAGER_API_URL_KEY = 'MANAGER_API_URL';

/** The name the admin read the manager's address under before {@link MANAGER_API_URL_KEY}, read when that is unset. */
export const MANAGER_API_URL_FORMER_KEY = 'MANAGER_FUNDING_URL';

/**
 * The manager's address as an env holds it, and the name it was read under: {@link MANAGER_API_URL_KEY} when that is
 * set to more than spaces, otherwise {@link MANAGER_API_URL_FORMER_KEY}. Null when neither is set. The value is
 * trimmed and checked by {@link managerFundingUrlProblem}.
 */
export function managerApiUrlFrom(
  env: Readonly<Record<string, string | undefined>>,
): { key: string; value: string } | null {
  for (const key of [MANAGER_API_URL_KEY, MANAGER_API_URL_FORMER_KEY]) {
    const value = env[key]?.trim();
    if (value) return { key, value };
  }
  return null;
}

/** The fewest characters the manager's API token may have: the manager's own floor for its `MANAGER_API_TOKEN`. */
export const MANAGER_API_TOKEN_MIN_LENGTH = 32;

/** The name Docker maps to the host inside a container. The deploy compose file maps it for the api. */
export const DOCKER_HOST_GATEWAY_NAME = 'host.docker.internal';

/** 32 bytes as hex, and nothing else: no `0x`, no space. */
const SECRET_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Printable ASCII with no space, which an HTTP header carries as it is. */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

/** 127.0.0.0/8, as the URL parser writes an IPv4 address. */
const LOOPBACK_IPV4_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * A host name of one label, as the URL parser leaves it: lower case, no dot. Only a Docker network's own DNS answers
 * such a name, for a service beside the admin, such as `manager`. An IPv6 address keeps its brackets and a numeric
 * name becomes a dotted IPv4 address, so neither matches.
 */
const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Why this cannot be `BRAND_WALLET_SECRET`, or null. */
export function brandWalletSecretProblem(value: string): string | null {
  return SECRET_PATTERN.test(value)
    ? null
    : `${BRAND_WALLET_SECRET_KEY} must be 64 hex characters (32 bytes), or unset for no brand wallet`;
}

/**
 * Whether plain http to this host stays on the admin's own machine: a loopback address, the Docker host's gateway,
 * or a Docker service name. The text alone decides; nothing is resolved.
 */
function isOwnHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === DOCKER_HOST_GATEWAY_NAME ||
    LOOPBACK_IPV4_PATTERN.test(hostname) ||
    SERVICE_NAME_PATTERN.test(hostname)
  );
}

/**
 * Why this cannot be the manager's address, or null. Every request to it carries the funding token, so it is https,
 * or plain http only to this host, the rule the manager holds its web2 admin link to: a loopback address,
 * `host.docker.internal`, or a Docker service name with no dot. It carries no user name or password, the token being
 * its one credential, and no `?` or `#` part, since the API's paths are added after it. `key` is the name it was read
 * under, which the sentence names: `MANAGER_API_URL` unless given.
 */
export function managerFundingUrlProblem(value: string, key: string = MANAGER_API_URL_KEY): string | null {
  const notAnAddress = `${key} must be an http or https address, such as https://manager.example.org`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return notAnAddress;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '') return notAnAddress;
  if (url.username !== '' || url.password !== '') {
    return `${key} cannot carry a user name or a password: the funding token is the one credential the manager takes`;
  }
  // The raw text, since `search` and `hash` are empty for a bare trailing ? or #.
  if (value.includes('?') || value.includes('#')) {
    return `${key} cannot carry a ? or # part, because the funding API's paths are added after it`;
  }
  if (url.protocol === 'http:' && !isOwnHost(url.hostname)) {
    return `${key} is plain http to another host, and every request carries the funding token: give the manager's https address. Plain http is taken only to this host: a loopback address, ${DOCKER_HOST_GATEWAY_NAME}, or a Docker service name with no dot`;
  }
  return null;
}

/**
 * The address the API's paths are added to: the origin and any path, without a trailing slash. Only for an address
 * {@link managerFundingUrlProblem} takes.
 */
export function managerFundingBaseUrl(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Why this cannot be the manager's API token, or null. It is the manager's `MANAGER_API_TOKEN`, the same value. `key`
 * is the name it was read under, which the sentence names: `MANAGER_API_TOKEN` unless given.
 */
export function managerApiTokenProblem(value: string, key: string = MANAGER_API_TOKEN_KEY): string | null {
  if (value.length < MANAGER_API_TOKEN_MIN_LENGTH) {
    return `${key} must be at least ${MANAGER_API_TOKEN_MIN_LENGTH} characters, got ${value.length}`;
  }
  if (!TOKEN_PATTERN.test(value)) {
    return `${key} must be printable ASCII with no space inside, since it travels in an HTTP header`;
  }
  return null;
}
